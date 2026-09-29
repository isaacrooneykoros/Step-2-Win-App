package com.step2win.app;

import java.util.ArrayList;
import java.util.List;

/**
 * Pure-Java timeline of "in a vehicle / on a bike" intervals from Activity Recognition
 * transitions (IN_VEHICLE, ON_BICYCLE ENTER / EXIT). Steps the phone counts inside such an
 * interval go to the "vehicle" evidence bucket (not a fraud flag: bumpy roads make counters
 * count, and cycling steps aren't walking).
 *
 * An ENTER without EXIT is treated as ended {@link #STALE_MS} after it started (a missed EXIT
 * must not swallow the rest of the day). Serialised as "start-end;start-end" (end -1 = open).
 */
public final class VehicleTimeline {
    static final long STALE_MS = 3 * 60 * 60_000L;
    static final long KEEP_MS = 9 * 24 * 60 * 60_000L;
    static final int MAX_INTERVALS = 400;

    private final List<long[]> intervals = new ArrayList<>(); // {start, end or -1}

    public synchronized void enter(long wallMs) {
        if (!intervals.isEmpty()) {
            long[] last = intervals.get(intervals.size() - 1);
            if (last[1] < 0) {
                if (wallMs - last[0] < STALE_MS) return; // already inside
                last[1] = last[0] + STALE_MS;           // close the stale one
            }
            if (last[1] >= 0 && wallMs < last[1]) wallMs = last[1];
        }
        intervals.add(new long[] {wallMs, -1});
        trim();
    }

    public synchronized void exit(long wallMs) {
        if (intervals.isEmpty()) return;
        long[] last = intervals.get(intervals.size() - 1);
        if (last[1] >= 0) return;
        last[1] = Math.max(last[0], Math.min(wallMs, last[0] + STALE_MS));
    }

    private static long end(long[] iv) {
        return iv[1] >= 0 ? iv[1] : iv[0] + STALE_MS;
    }

    public synchronized boolean activeAt(long wallMs) {
        for (int i = intervals.size() - 1; i >= 0; i--) {
            long[] iv = intervals.get(i);
            if (wallMs >= iv[0] && wallMs < end(iv)) return true;
            if (end(iv) < wallMs - STALE_MS) break;
        }
        return false;
    }

    /** Fraction (0..1) of [startMs, endMs) covered by vehicle intervals. */
    public synchronized double overlapFraction(long startMs, long endMs) {
        if (endMs <= startMs) return activeAt(endMs) ? 1.0 : 0.0;
        long covered = 0;
        for (long[] iv : intervals) {
            long s = Math.max(startMs, iv[0]);
            long e = Math.min(endMs, end(iv));
            if (e > s) covered += e - s;
        }
        return Math.max(0.0, Math.min(1.0, covered / (double) (endMs - startMs)));
    }

    public synchronized void prune(long nowMs) {
        long cutoff = nowMs - KEEP_MS;
        while (!intervals.isEmpty() && end(intervals.get(0)) < cutoff) intervals.remove(0);
    }

    private void trim() {
        while (intervals.size() > MAX_INTERVALS) intervals.remove(0);
    }

    public synchronized int size() {
        return intervals.size();
    }

    public synchronized String serialize() {
        StringBuilder sb = new StringBuilder();
        for (long[] iv : intervals) {
            if (sb.length() > 0) sb.append(';');
            sb.append(iv[0]).append(',').append(iv[1]);
        }
        return sb.toString();
    }

    public static VehicleTimeline parse(String text) {
        VehicleTimeline t = new VehicleTimeline();
        if (text == null || text.isEmpty()) return t;
        for (String part : text.split(";")) {
            String[] p = part.split(",");
            if (p.length != 2) continue;
            try {
                t.intervals.add(new long[] {Long.parseLong(p[0].trim()), Long.parseLong(p[1].trim())});
            } catch (NumberFormatException ignored) {
                // skip a corrupt entry
            }
        }
        return t;
    }
}
