package com.step2win.app;

/**
 * Pure-Java tally of gait-window verdicts over a span (one minute of the day, or the last
 * ~30 s of a walk) and the rule that turns it into one evidence verdict for the steps the
 * hardware counter counted in that span.
 *
 * VERIFIED needs all of:
 * - at least {@link #MIN_STEADY_WINDOWS} gait windows (~20 s; a minute that just started is
 *   judged together with the previous one),
 * - gait (walking / running) in at least half of the windows that saw movement,
 * - shake-like windows in at most a quarter of them,
 * - the counter's step count roughly agrees with the steps the accelerometer saw (within a
 *   factor of ~2: stride/step ambiguity and counter batching latency), when the counter count
 *   is known,
 * - the cadence is not machine-steady (see below).
 * SHAKE needs clear evidence: shake-like windows in at least half of the moving windows (and at
 * least 2), or a cadence that stays constant to within {@link #MACHINE_CADENCE_CV} over at least
 * {@link #MIN_STEADY_WINDOWS} windows (motors, pendulums and fans repeat exactly; a person's
 * cadence wanders by ~1 % or more even on a treadmill). Everything else is UNKNOWN.
 */
public final class WindowTally {
    public static final int VERIFIED = 0;
    public static final int SHAKE = 1;
    public static final int UNKNOWN = 2;

    static final double MACHINE_CADENCE_CV = 0.0035;
    static final double DOUBT_CADENCE_CV = 0.0050;
    static final int MIN_STEADY_WINDOWS = 8;

    int walking;
    int running;
    int shake;
    int unknown;
    int idle;
    /** Steps the accelerometer saw in gait windows: sum of step frequency x hop length. */
    double expectedSteps;
    int freqCount;
    double freqSum;
    double freqSumSq;

    public void add(GaitClassifier.Result r) {
        if (r == null) return;
        switch (r.verdict) {
            case WALKING:
                walking++;
                break;
            case RUNNING:
                running++;
                break;
            case SHAKE:
                shake++;
                break;
            case IDLE:
                idle++;
                break;
            default:
                unknown++;
                break;
        }
        if (r.verdict.isGait()) {
            expectedSteps += r.stepFreqHz * GaitWindowBuffer.HOP_MS / 1000.0;
        }
        if ((r.verdict.isGait() || "mechanical".equals(r.reason)) && !Double.isNaN(r.peakFreqHz) && r.peakFreqHz > 0) {
            freqCount++;
            freqSum += r.peakFreqHz;
            freqSumSq += r.peakFreqHz * r.peakFreqHz;
        }
    }

    public void addAll(WindowTally other) {
        if (other == null) return;
        walking += other.walking;
        running += other.running;
        shake += other.shake;
        unknown += other.unknown;
        idle += other.idle;
        expectedSteps += other.expectedSteps;
        freqCount += other.freqCount;
        freqSum += other.freqSum;
        freqSumSq += other.freqSumSq;
    }

    public int windows() {
        return walking + running + shake + unknown + idle;
    }

    public int moving() {
        return walking + running + shake + unknown;
    }

    /** Coefficient of variation of the per-window cadence (NaN if too few windows). */
    public double cadenceCv() {
        if (freqCount < MIN_STEADY_WINDOWS) return Double.NaN;
        double mean = freqSum / freqCount;
        double var = Math.max(0, freqSumSq / freqCount - mean * mean);
        return mean > 0 ? Math.sqrt(var) / mean : Double.NaN;
    }

    /** True when the counter count and the accelerometer's step estimate roughly agree. */
    public static boolean cadenceAgrees(int counterSteps, double expected) {
        if (counterSteps < 0) return true; // counter not observed (accelerometer-only walk)
        if (expected < 1) return counterSteps <= 3;
        if (Math.abs(counterSteps - expected) <= 15) return true;
        double ratio = counterSteps / expected;
        return ratio >= 0.5 && ratio <= 2.3;
    }

    /**
     * Evidence verdict for the counter steps of this span. counterSteps < 0 = not known
     * (skips the agreement check).
     */
    public int verdict(int counterSteps) {
        int moving = moving();
        if (moving == 0) return UNKNOWN;
        double cv = cadenceCv();
        if (!Double.isNaN(cv) && cv < MACHINE_CADENCE_CV) return SHAKE;
        if (shake >= 2 && shake * 2 >= moving) return SHAKE;
        int gait = walking + running;
        boolean steadyDoubt = !Double.isNaN(cv) && cv < DOUBT_CADENCE_CV;
        // at least ~20 s of gait: enough context to rule out a machine-steady cadence
        if (!steadyDoubt && gait >= MIN_STEADY_WINDOWS && gait * 2 >= moving && shake * 4 <= moving
            && cadenceAgrees(counterSteps, expectedSteps)) {
            return VERIFIED;
        }
        return UNKNOWN;
    }

    /** Short machine-readable reason for logs / debugging. */
    public String reason(int counterSteps) {
        int moving = moving();
        if (moving == 0) return windows() == 0 ? "not_analysed" : "still";
        double cv = cadenceCv();
        if (!Double.isNaN(cv) && cv < MACHINE_CADENCE_CV) return "machine_steady_cadence";
        if (shake >= 2 && shake * 2 >= moving) return "shake_like";
        if (!Double.isNaN(cv) && cv < DOUBT_CADENCE_CV) return "very_steady_cadence";
        int gait = walking + running;
        if (gait < MIN_STEADY_WINDOWS) return "too_little_gait";
        if (gait * 2 < moving) return "inconclusive";
        if (shake * 4 > moving) return "mixed";
        if (!cadenceAgrees(counterSteps, expectedSteps)) return "counter_accel_mismatch";
        return "gait";
    }
}
