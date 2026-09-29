package com.step2win.app;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Per-minute walking evidence ("android_gait_v1"). Pure Java: JVM unit-testable.
 *
 * ── What it records ──────────────────────────────────────────────────────────────
 * For every wall-clock minute in which motion analysis ran and/or the live step-counter
 * listener saw steps:
 *   - counter steps seen live in that minute (hardware TYPE_STEP_COUNTER deltas),
 *   - the gait-window verdicts of that minute ({@link GaitClassifier}, one per 2.5 s),
 *   - the accelerometer's own step estimate (cadence x time) to compare with the counter,
 *   - the per-window cadence spread (machine-steady cadence = shaker / pendulum / fan),
 *   - whether a user walk was active, and whether the walk's GPS showed vehicle speed.
 *
 * ── How counted steps are attributed ─────────────────────────────────────────────
 * The ledger (StepLedger / LedgerCore) remains the single source of truth for step totals.
 * Every time it adds N steps over a time span (per local hour), it asks {@link #attribute} to
 * split those N steps into exactly one bucket each:
 *   1. steps seen live in minutes of that span are taken first (each observed step is used
 *      once): VEHICLE if Activity Recognition said IN_VEHICLE / ON_BICYCLE at that minute or
 *      the walk's GPS showed vehicle speed; else WALK if a user walk was active; else the
 *      minute's gait verdict (VERIFIED / SHAKE / UNKNOWN, see {@link WindowTally}).
 *   2. the rest (nothing was listening: app closed, no walking service) is split by time:
 *      the share of the span inside a vehicle interval goes to VEHICLE, the remainder to
 *      UNKNOWN ("not analysed"). Missing sensors therefore always mean UNKNOWN, never SHAKE.
 * The ledger stores the resulting per-hour buckets next to its hour totals (same retention,
 * same atomic write), so verified + shake + unknown + vehicle + walk == hour steps always.
 * A minute still in progress is judged together with the previous minute when it has fewer
 * than 4 windows (provisional verdicts need context).
 *
 * ── Battery ─────────────────────────────────────────────────────────────────────
 * Motion analysis (accelerometer ~50 Hz + gyroscope / gravity when present) runs ONLY while:
 *   (a) the app is open (the plugin's foreground listener),
 *   (b) the automatic walking service runs (challenge days, started by an Activity
 *       Recognition walking transition, stops after 5 idle minutes, max 3 h), or
 *   (c) the user runs a "Start a walk" session (max 4 h, auto-ends after inactivity).
 * Outside those times nothing extra runs: the hardware step counter keeps counting on its own
 * low-power hub, WorkManager reads it every 15-60 min, and those steps are "unknown".
 * Motion sensors are registered with a 2 s maxReportLatency, so phones with a sensor FIFO
 * deliver them in batches and the CPU can sleep between batches; the analysis itself is one
 * 256-point FFT set + autocorrelation every 2.5 s (well under 1 ms of CPU on a budget phone).
 * Estimated cost while analysis runs: accelerometer ~0.1-0.3 mA, gyroscope ~0.5-1.5 mA (the
 * dominant term; phones without one skip it), CPU wakeups ~1-2 mA with FIFO batching, i.e.
 * about 1-2 % battery per hour of analysed walking on a 4000-5000 mAh budget phone, and zero
 * when none of (a)-(c) is active. No periodic background sensor sampling was added: it would
 * cost wakeups all day for little evidence, and those steps are simply "unknown".
 */
public final class EvidenceTracker {
    public static final EvidenceTracker SHARED = new EvidenceTracker();

    public static final int VERIFIED = 0;
    public static final int SHAKE = 1;
    public static final int UNKNOWN = 2;
    public static final int VEHICLE = 3;
    public static final int WALK = 4;
    /** Index 5 of an attribution result: how many of the steps were not observed at all. */
    public static final int NOT_ANALYSED = 5;

    static final long KEEP_MS = 3 * 60 * 60_000L;
    static final long SLACK_MS = 60_000L; // counter batching: observed steps may precede the ledger span

    /** One wall-clock minute. */
    public static final class Minute {
        public final long minute; // epoch minute
        int counter;
        int used;
        final WindowTally tally = new WindowTally();
        boolean inWalk;
        boolean walkVehicle;
        boolean summarised;

        Minute(long minute) {
            this.minute = minute;
        }

        public long startMs() {
            return minute * 60_000L;
        }

        public int counterSteps() {
            return counter;
        }

        public boolean analysed() {
            return tally.windows() > 0;
        }
    }

    /** Vehicle lookup (Activity Recognition). */
    public interface VehicleCheck {
        boolean activeAt(long wallMs);

        double overlapFraction(long startMs, long endMs);
    }

    public static final VehicleCheck NO_VEHICLE = new VehicleCheck() {
        @Override
        public boolean activeAt(long wallMs) {
            return false;
        }

        @Override
        public double overlapFraction(long startMs, long endMs) {
            return 0;
        }
    };

    public static VehicleCheck of(final VehicleTimeline timeline) {
        if (timeline == null) return NO_VEHICLE;
        return new VehicleCheck() {
            @Override
            public boolean activeAt(long wallMs) {
                return timeline.activeAt(wallMs);
            }

            @Override
            public double overlapFraction(long startMs, long endMs) {
                return timeline.overlapFraction(startMs, endMs);
            }
        };
    }

    private final TreeMap<Long, Minute> minutes = new TreeMap<>();
    private volatile boolean walkActive = false;
    private volatile long lastWindowWall = 0L;

    // ── inputs ───────────────────────────────────────────────────────────────

    public synchronized void onWindow(long wallMs, GaitClassifier.Result result) {
        if (result == null) return;
        Minute m = minute(wallMs);
        m.tally.add(result);
        if (walkActive) m.inWalk = true;
        lastWindowWall = wallMs;
        prune(wallMs);
    }

    public synchronized void onCounterSteps(long wallMs, int steps) {
        if (steps <= 0) return;
        Minute m = minute(wallMs);
        m.counter += steps;
        if (walkActive) m.inWalk = true;
        prune(wallMs);
    }

    public void setWalkActive(boolean active) {
        walkActive = active;
    }

    public boolean walkActive() {
        return walkActive;
    }

    /** The user's walk showed vehicle speed (GPS) during this minute. */
    public synchronized void markWalkVehicle(long wallMs) {
        minute(wallMs).walkVehicle = true;
    }

    /** Wall time of the last analysed window (0 = never). */
    public long lastWindowAt() {
        return lastWindowWall;
    }

    private Minute minute(long wallMs) {
        long key = Math.floorDiv(wallMs, 60_000L);
        Minute m = minutes.get(key);
        if (m == null) {
            m = new Minute(key);
            minutes.put(key, m);
        }
        return m;
    }

    private void prune(long nowMs) {
        long cutoff = Math.floorDiv(nowMs - KEEP_MS, 60_000L);
        while (!minutes.isEmpty() && minutes.firstKey() < cutoff) minutes.pollFirstEntry();
    }

    // ── verdicts ─────────────────────────────────────────────────────────────

    /** Gait verdict of a minute (VERIFIED / SHAKE / UNKNOWN), with context for young minutes. */
    synchronized int gaitVerdict(Minute m) {
        WindowTally t = m.tally;
        int counter = m.counter;
        if (t.moving() < 4) {
            Minute prev = minutes.get(m.minute - 1);
            if (prev != null && prev.tally.windows() > 0) {
                WindowTally combined = new WindowTally();
                combined.addAll(prev.tally);
                combined.addAll(t);
                t = combined;
                counter += prev.counter;
            }
        }
        int v = t.verdict(counter);
        return v == WindowTally.VERIFIED ? VERIFIED : v == WindowTally.SHAKE ? SHAKE : UNKNOWN;
    }

    synchronized int bucket(Minute m, VehicleCheck vehicle) {
        long mid = m.startMs() + 30_000L;
        if (m.walkVehicle || (vehicle != null && vehicle.activeAt(mid))) return VEHICLE;
        if (m.inWalk) return WALK;
        return gaitVerdict(m);
    }

    // ── attribution ──────────────────────────────────────────────────────────

    /**
     * Splits `steps` (added by the ledger over [startMs, endMs)) into buckets. Returns int[6]:
     * VERIFIED, SHAKE, UNKNOWN, VEHICLE, WALK (these five sum to `steps`) and NOT_ANALYSED
     * (the part of UNKNOWN + VEHICLE that no live listener saw).
     */
    public synchronized int[] attribute(int steps, long startMs, long endMs, VehicleCheck vehicle) {
        int[] out = new int[6];
        if (steps <= 0) return out;
        int remaining = steps;
        long fromKey = Math.floorDiv(startMs - SLACK_MS, 60_000L);
        long toKey = Math.floorDiv(Math.max(startMs, endMs), 60_000L);
        for (Map.Entry<Long, Minute> e : minutes.subMap(fromKey, true, toKey, true).entrySet()) {
            if (remaining <= 0) break;
            Minute m = e.getValue();
            int free = m.counter - m.used;
            if (free <= 0) continue;
            int take = Math.min(free, remaining);
            m.used += take;
            out[bucket(m, vehicle)] += take;
            remaining -= take;
        }
        if (remaining > 0) {
            double frac = vehicle == null ? 0 : vehicle.overlapFraction(startMs, endMs);
            int veh = (int) Math.round(remaining * frac);
            out[VEHICLE] += veh;
            out[UNKNOWN] += remaining - veh;
            out[NOT_ANALYSED] += remaining;
        }
        return out;
    }

    /** Closed minute facts for the hour summary (active minutes, gait minutes). */
    public static final class MinuteFacts {
        public final long startMs;
        public final boolean active;
        public final boolean analysed;

        MinuteFacts(long startMs, boolean active, boolean analysed) {
            this.startMs = startMs;
            this.active = active;
            this.analysed = analysed;
        }
    }

    /** Minutes that ended before `beforeMs` and weren't summarised yet (each returned once). */
    public synchronized List<MinuteFacts> drainClosed(long beforeMs) {
        List<MinuteFacts> out = new ArrayList<>();
        long lastClosed = Math.floorDiv(beforeMs, 60_000L) - 1;
        Iterator<Map.Entry<Long, Minute>> it = minutes.headMap(lastClosed, true).entrySet().iterator();
        while (it.hasNext()) {
            Minute m = it.next().getValue();
            if (m.summarised) continue;
            m.summarised = true;
            if (m.counter > 0 || m.analysed()) {
                out.add(new MinuteFacts(m.startMs(), m.counter > 0, m.analysed()));
            }
        }
        return out;
    }

    /** Test / debug view. */
    synchronized Minute peek(long wallMs) {
        return minutes.get(Math.floorDiv(wallMs, 60_000L));
    }

    public synchronized void clear() {
        minutes.clear();
        walkActive = false;
        lastWindowWall = 0L;
    }
}
