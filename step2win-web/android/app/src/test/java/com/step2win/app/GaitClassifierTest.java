package com.step2win.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.List;

/**
 * Synthetic-signal scenarios for the gait classifier: honest walking / running in a pocket,
 * hand or bag must be verified; shaking, shakers, pendulums, fans and vibration must not be;
 * missing sensors must give "unknown", never "shake".
 *
 * Each scenario records 60 s (about 22 windows) and checks both the per-window verdicts and
 * the one-minute evidence verdict ({@link WindowTally}) the ledger would use.
 */
public class GaitClassifierTest {
    private static final double SECONDS = 60;

    private static final class Outcome {
        int gait, shake, unknown, idle, total;
        int minuteVerdict;
        String minuteReason;
        WindowTally tally = new WindowTally();

        double gaitShare() {
            return total == 0 ? 0 : gait / (double) total;
        }

        double shakeShare() {
            return total == 0 ? 0 : shake / (double) total;
        }

        @Override
        public String toString() {
            return "gait=" + gait + " shake=" + shake + " unknown=" + unknown + " idle=" + idle + " of " + total
                + " minute=" + minuteVerdict + "(" + minuteReason + ")";
        }
    }

    /** counterSpm: what the phone's hardware counter would count per minute (-1 = unknown). */
    private static Outcome run(SyntheticMotion.Model model, double rateHz, long seed, boolean gyro, boolean gravity, int counterSpm) {
        List<SyntheticMotion.Sample> samples = SyntheticMotion.generate(model, SECONDS, rateHz, seed, gyro, gravity);
        List<GaitClassifier.Result> results = SyntheticMotion.classify(samples);
        Outcome o = new Outcome();
        for (GaitClassifier.Result r : results) {
            o.total++;
            o.tally.add(r);
            if (r.verdict.isGait()) o.gait++;
            else if (r.verdict == GaitClassifier.Verdict.SHAKE) o.shake++;
            else if (r.verdict == GaitClassifier.Verdict.IDLE) o.idle++;
            else o.unknown++;
        }
        // the windows cover ~55 s of the minute: scale the counter accordingly
        int counter = counterSpm < 0 ? -1 : (int) Math.round(counterSpm * o.total * GaitWindowBuffer.HOP_MS / 60_000.0);
        o.minuteVerdict = o.tally.verdict(counter);
        o.minuteReason = o.tally.reason(counter);
        return o;
    }

    private static void assertVerifiedGait(String name, SyntheticMotion.Model model, boolean gyro, boolean gravity, int spm, long seed) {
        Outcome o = run(model, 50, seed, gyro, gravity, spm);
        assertTrue(name + ": " + o, o.gaitShare() >= 0.85);
        assertEquals(name + ": " + o, 0, o.shake);
        assertEquals(name + ": " + o, WindowTally.VERIFIED, o.minuteVerdict);
    }

    /**
     * The minute's steps must be "shake". (Single windows of a machine may still look like gait:
     * a steady motor is only unmasked by its cadence staying constant over the minute.)
     */
    private static void assertShake(String name, Outcome o) {
        assertEquals(name + ": " + o, WindowTally.SHAKE, o.minuteVerdict);
    }

    // ── honest walking ───────────────────────────────────────────────────────

    @Test
    public void walkingInPocketIsVerified() {
        for (long seed = 1; seed <= 5; seed++) {
            for (int spm : new int[] {90, 110, 130}) {
                assertVerifiedGait("pocket " + spm, SyntheticMotion.walk(spm, SyntheticMotion.Carry.POCKET, SECONDS + 5, seed), true, true, spm, seed);
            }
        }
    }

    @Test
    public void walkingWithPhoneInHandIsVerified() {
        for (long seed = 1; seed <= 5; seed++) {
            for (int spm : new int[] {90, 110, 130}) {
                assertVerifiedGait("hand " + spm, SyntheticMotion.walk(spm, SyntheticMotion.Carry.HAND_TEXTING, SECONDS + 5, seed), true, true, spm, seed);
                assertVerifiedGait("swinging hand " + spm, SyntheticMotion.walk(spm, SyntheticMotion.Carry.HAND_SWINGING, SECONDS + 5, seed), true, true, spm, seed);
            }
        }
    }

    @Test
    public void walkingWithPhoneInBagIsVerified() {
        for (long seed = 1; seed <= 5; seed++) {
            for (int spm : new int[] {90, 110, 130}) {
                assertVerifiedGait("bag " + spm, SyntheticMotion.walk(spm, SyntheticMotion.Carry.BAG, SECONDS + 5, seed), true, true, spm, seed);
            }
        }
    }

    @Test
    public void runningAt180And200IsVerified() {
        for (long seed = 1; seed <= 4; seed++) {
            for (int spm : new int[] {180, 200}) {
                for (SyntheticMotion.Carry carry : SyntheticMotion.Carry.values()) {
                    Outcome o = run(SyntheticMotion.run(spm, carry, SECONDS + 5, seed), 50, seed, true, true, spm);
                    String name = "run " + carry + " " + spm + " seed " + seed;
                    assertTrue(name + ": " + o, o.gaitShare() >= 0.85);
                    assertEquals(name + ": " + o, WindowTally.VERIFIED, o.minuteVerdict);
                }
            }
        }
    }

    @Test
    public void runnerCadenceIsReportedAsRunning() {
        List<GaitClassifier.Result> results = SyntheticMotion.classify(
            SyntheticMotion.generate(SyntheticMotion.run(190, SyntheticMotion.Carry.POCKET, 40, 3), 30, 50, 3, true, true));
        int running = 0;
        for (GaitClassifier.Result r : results) {
            if (r.verdict == GaitClassifier.Verdict.RUNNING) {
                running++;
                assertEquals(190, r.cadenceSpm(), 12);
            }
        }
        assertTrue(running >= results.size() - 1);
    }

    @Test
    public void accelerometerOnlyPhoneWalkingIsVerifiedOrAtWorstUnknown() {
        for (long seed = 1; seed <= 5; seed++) {
            for (SyntheticMotion.Carry carry : SyntheticMotion.Carry.values()) {
                Outcome o = run(SyntheticMotion.walk(105, carry, SECONDS + 5, seed), 50, seed, false, false, 105);
                String name = "accel-only " + carry + " seed " + seed;
                assertEquals(name + ": " + o, 0, o.shake);
                assertNotEquals(name + ": " + o, WindowTally.SHAKE, o.minuteVerdict);
                // in practice the synthetic walkers are fully verified without gyro / gravity
                assertEquals(name + ": " + o, WindowTally.VERIFIED, o.minuteVerdict);
            }
            Outcome running = run(SyntheticMotion.run(190, SyntheticMotion.Carry.POCKET, SECONDS + 5, seed), 50, seed, false, false, 190);
            assertEquals("accel-only running: " + running, WindowTally.VERIFIED, running.minuteVerdict);
        }
    }

    @Test
    public void walkingSampledAt100HzIsVerified() {
        Outcome o = run(SyntheticMotion.walk(112, SyntheticMotion.Carry.POCKET, SECONDS + 5, 9), 100, 9, true, true, 112);
        assertEquals(o.toString(), WindowTally.VERIFIED, o.minuteVerdict);
    }

    // ── not walking ──────────────────────────────────────────────────────────

    @Test
    public void handShakingIsShake() {
        for (long seed = 1; seed <= 5; seed++) {
            assertShake("hand shake seed " + seed, run(SyntheticMotion.handShake(seed), 50, seed, true, true, 150));
            assertShake("hand shake accel-only seed " + seed, run(SyntheticMotion.handShake(seed), 50, seed, false, false, 150));
        }
    }

    @Test
    public void mechanicalShakerIsShake() {
        // a motor moving the phone up and down at a walking-like rate: perfectly regular
        for (double hz : new double[] {1.6, 1.8, 2.0, 2.3}) {
            assertShake("shaker " + hz, run(SyntheticMotion.verticalShaker(hz, 0.03), 50, 3, true, true, (int) (hz * 60)));
            assertShake("shaker accel-only " + hz, run(SyntheticMotion.verticalShaker(hz, 0.03), 50, 3, false, false, (int) (hz * 60)));
        }
    }

    @Test
    public void rockingCradleIsShake() {
        for (double hz : new double[] {1.2, 1.8, 2.2}) {
            assertShake("rocker " + hz, run(SyntheticMotion.rocker(hz, 0.35, 0.12), 50, 4, true, true, (int) (hz * 60)));
            assertShake("rocker accel-only " + hz, run(SyntheticMotion.rocker(hz, 0.35, 0.12), 50, 4, false, false, (int) (hz * 60)));
        }
    }

    @Test
    public void pendulumIsShake() {
        for (double length : new double[] {0.25, 0.35, 0.6}) {
            double swingHz = Math.sqrt(9.81 / length) / (2 * Math.PI);
            int counter = (int) Math.round(2 * swingHz * 60);
            assertShake("pendulum " + length, run(SyntheticMotion.pendulum(length, 0.45), 50, 5, true, true, counter));
            assertShake("pendulum accel-only " + length, run(SyntheticMotion.pendulum(length, 0.45), 50, 5, false, false, counter));
        }
    }

    @Test
    public void ceilingFanIsShake() {
        // phone taped to a blade (large centripetal) and near the hub (small), with / without gyroscope
        assertShake("fan blade", run(SyntheticMotion.ceilingFan(90, 0.15), 50, 6, true, true, 90));
        assertShake("fan blade accel-only", run(SyntheticMotion.ceilingFan(90, 0.15), 50, 6, false, false, 90));
        assertShake("fan hub", run(SyntheticMotion.ceilingFan(110, 0.04), 50, 6, true, true, 110));
        assertShake("fan hub accel-only", run(SyntheticMotion.ceilingFan(110, 0.04), 50, 6, false, false, 110));
    }

    @Test
    public void washingMachineIsShake() {
        for (long seed = 1; seed <= 3; seed++) {
            assertShake("washing machine", run(SyntheticMotion.washingMachine(seed), 50, seed, true, true, 100));
            assertShake("washing machine 100 Hz", run(SyntheticMotion.washingMachine(seed), 100, seed, true, true, 100));
        }
    }

    @Test
    public void dashboardVibrationIsNotVerified() {
        for (long seed = 1; seed <= 5; seed++) {
            Outcome o = run(SyntheticMotion.dashboard(seed), 50, seed, true, true, 60);
            assertNotEquals("dashboard seed " + seed + ": " + o, WindowTally.VERIFIED, o.minuteVerdict);
            assertTrue("dashboard seed " + seed + ": " + o, o.gaitShare() < 0.3);
        }
    }

    // ── missing / insufficient data ──────────────────────────────────────────

    @Test
    public void missingSensorDataIsUnknownNeverShake() {
        // no accelerometer at all: no windows; the counter's steps are "unknown"
        WindowTally empty = new WindowTally();
        assertEquals(WindowTally.UNKNOWN, empty.verdict(120));
        assertEquals("not_analysed", empty.reason(120));
        // a sensor that delivers far too few samples
        Outcome slow = run(SyntheticMotion.walk(110, SyntheticMotion.Carry.POCKET, SECONDS + 5, 1), 8, 1, true, true, 110);
        assertEquals(slow.toString(), 0, slow.shake);
        assertEquals(slow.toString(), WindowTally.UNKNOWN, slow.minuteVerdict);
        // gaps (sensor paused) reset the window instead of mixing data across the gap
        GaitWindowBuffer buffer = new GaitWindowBuffer();
        GaitClassifier.Result any = null;
        for (int i = 0; i < 400; i++) {
            long t = 1_000L + i * 20L + (i / 50) * 1_500L; // a 1.5 s gap every second
            GaitClassifier.Result r = buffer.add(t, 0.1f, 9.8f, 0.2f, Float.NaN, Float.NaN, Float.NaN, Float.NaN);
            if (r != null) any = r;
        }
        assertEquals(null, any);
    }

    @Test
    public void phoneOnTableIsIdle() {
        Outcome o = run(SyntheticMotion.still(), 50, 1, true, true, 0);
        assertEquals(o.total, o.idle);
        assertEquals(WindowTally.UNKNOWN, o.minuteVerdict);
        // counter steps while the phone lies still: not walking evidence
        assertEquals(WindowTally.UNKNOWN, o.tally.verdict(80));
    }

    @Test
    public void emptyOrBrokenWindowIsUnknown() {
        assertEquals(GaitClassifier.Verdict.UNKNOWN, GaitClassifier.classify(null).verdict);
        double[] zeros = new double[GaitClassifier.N];
        GaitClassifier.Result r = GaitClassifier.classify(new GaitClassifier.Window(zeros, zeros, zeros, null, null));
        assertEquals(GaitClassifier.Verdict.UNKNOWN, r.verdict);
        assertEquals("gravity_unclear", r.reason);
    }

    // ── minute rules ─────────────────────────────────────────────────────────

    @Test
    public void counterWithoutMatchingAccelerometerRhythmIsNotVerified() {
        Outcome o = run(SyntheticMotion.walk(100, SyntheticMotion.Carry.POCKET, SECONDS + 5, 2), 50, 2, true, true, 100);
        int windows = o.total;
        int plausible = (int) Math.round(100 * windows * 2.5 / 60.0);
        assertEquals(WindowTally.VERIFIED, o.tally.verdict(plausible));
        // the counter claims 3x what the accelerometer saw: steps injected / counted elsewhere
        assertEquals(WindowTally.UNKNOWN, o.tally.verdict(plausible * 3));
        assertEquals("counter_accel_mismatch", o.tally.reason(plausible * 3));
        // stride/step ambiguity (counter at twice the accelerometer's rhythm) is tolerated
        assertTrue(WindowTally.cadenceAgrees(200, 100));
        assertTrue(WindowTally.cadenceAgrees(55, 100));
        assertTrue(!WindowTally.cadenceAgrees(40, 100));
    }

    @Test
    public void machineSteadyCadenceOverAMinuteIsShake() {
        // windows that each pass as gait but whose cadence never varies (a motor): shake
        WindowTally t = new WindowTally();
        for (int i = 0; i < 20; i++) {
            GaitClassifier.Result r = new GaitClassifier.Result();
            r.verdict = GaitClassifier.Verdict.WALKING;
            r.reason = "gait";
            r.stepFreqHz = 1.8;
            r.peakFreqHz = 1.8 * (1 + 0.001 * Math.sin(i));
            t.add(r);
        }
        assertEquals(WindowTally.SHAKE, t.verdict(108));
        assertEquals("machine_steady_cadence", t.reason(108));
        // a person's cadence wanders by ~1 %+: verified
        WindowTally human = new WindowTally();
        java.util.Random rnd = new java.util.Random(4);
        for (int i = 0; i < 20; i++) {
            GaitClassifier.Result r = new GaitClassifier.Result();
            r.verdict = GaitClassifier.Verdict.WALKING;
            r.reason = "gait";
            r.stepFreqHz = 1.8;
            r.peakFreqHz = 1.8 * (1 + 0.012 * rnd.nextGaussian());
            human.add(r);
        }
        assertEquals(WindowTally.VERIFIED, human.verdict(108));
    }
}
