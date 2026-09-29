package com.step2win.app;

/**
 * Pure-Java (no Android dependencies, JVM unit-testable) classifier for one ~5 s window of
 * accelerometer (+ optional gyroscope / gravity sensor) data: WALKING, RUNNING, SHAKE (motion
 * that clearly is not walking), IDLE (phone still) or UNKNOWN (inconclusive / not enough data).
 *
 * Principle: "shake" needs clear positive evidence of non-walking motion; anything we can't
 * decide, or can't measure (missing sensor, low sample rate), is UNKNOWN, never SHAKE.
 *
 * The window arrives already resampled onto a uniform {@link #FS} Hz grid (see
 * {@link GaitWindowBuffer}). Features (all robust to phone orientation):
 *
 * - gravity direction: mean of the gravity sensor if present, else the mean of the raw
 *   accelerometer over the window (a low-pass estimate: linear acceleration averages out over
 *   several steps). |mean accel| far above 1 g for 5 s = sustained centripetal acceleration
 *   (a phone strapped to a fan blade / spinning device): people don't walk like that.
 * - vertical signal: dynamic acceleration projected on gravity. Walking and running produce a
 *   heel-strike / impact rhythm on this axis, whatever the carry position (pocket, bag, hand).
 * - vertical energy share: energy on the gravity axis / total dynamic energy. A phone rocked or
 *   spun in the horizontal plane has almost none.
 * - spectral shares (Hann-windowed FFT of the three dynamic axes): energy in the gait band
 *   (0.5-4 Hz) and above 7 Hz. Engines, washing machines and other vibration live above 7 Hz;
 *   hand shaking mostly at 3.5-7 Hz; walking (1.3-2.3 Hz) and running (2.5-3.4 Hz) below.
 * - step period from the autocorrelation of the band-limited (0.5-4.5 Hz) vertical signal in
 *   the 0.26-1.18 s lag range (51-231 steps/min), preferring the step lag over the stride lag
 *   (left/right asymmetry makes the stride lag correlate best in a pocket).
 * - autocorrelation at the step and stride lags: periodicity. Human gait: typically 0.4-0.9.
 * - step-interval variability: peaks of the band-limited vertical signal, timed with parabolic
 *   interpolation (sub-sample precision). Humans vary 1.5-6 % step to step; a motor, a pendulum
 *   or a fan repeats within a fraction of a percent. Coefficient of variation < 0.8 % together
 *   with near-perfect periodicity = mechanical. Very irregular (> 20 %) = not gait.
 * - spectral purity: share of vertical energy at the fundamental. A heel strike is an impulse
 *   with harmonics; a machine / pendulum is close to a pure sine. Used only together with very
 *   high regularity (a bag can damp harmonics, so purity alone never condemns).
 * - jerk (RMS derivative of the dynamic acceleration) and gyroscope magnitude mean / std:
 *   vigorous hand shaking is jerky and rotationally chaotic but not periodic. A steady large
 *   rotation rate with little variation is a spinning object (fan). Gyroscope-based rules are
 *   skipped on phones without a gyroscope (never treated as "no rotation").
 *
 * Thresholds were chosen with a wide margin around human gait literature values (cadence
 * 60-220 spm, step-time CV 1.5-6 %, gait-band energy dominant) and validated on synthetic
 * signals for every scenario in GaitClassifierTest. Where human gait and a cheat could
 * overlap, the classifier answers UNKNOWN (doubt lowers confidence, it never wipes).
 */
public final class GaitClassifier {
    public static final int FS = 50;          // grid rate (Hz)
    public static final int N = 256;          // window length: 5.12 s
    static final double DF = FS / (double) N; // FFT bin width: 0.195 Hz

    static final double IDLE_RMS = 0.30;              // m/s^2 dynamic RMS below which the phone is "still"
    // m/s^2: a sustained 2 g for 5 s = spinning object. (A phone swung in a runner's hand can
    // average ~1.3-1.5 g in the device frame from the arm's centripetal acceleration, so the
    // limit is well above that.)
    static final double MAX_MEAN_ACCEL = 20.0;
    static final double MIN_MEAN_ACCEL = 6.0;          // below: free fall / broken data -> unknown
    static final double VIBRATION_SHARE = 0.55;        // energy share above 7 Hz
    static final double MIN_GAIT_SHARE = 0.35;         // energy share in 0.5-4 Hz needed for gait
    static final double MECHANICAL_CV = 0.005;         // step-interval CV below which motion is machine-like
    static final double MAX_HUMAN_CV = 0.20;           // above: too irregular for gait
    static final double MIN_STEP_HZ = 0.9;             // 54 spm
    static final double MAX_STEP_HZ = 3.75;            // 225 spm
    static final double RUN_STEP_HZ = 2.45;            // >= 147 spm reported as running

    private GaitClassifier() {}

    public enum Verdict {
        WALKING("walking"),
        RUNNING("running"),
        SHAKE("shake_like"),
        IDLE("idle"),
        UNKNOWN("unknown");

        public final String apiValue;

        Verdict(String apiValue) {
            this.apiValue = apiValue;
        }

        public boolean isGait() {
            return this == WALKING || this == RUNNING;
        }
    }

    /** One window on the uniform grid. gravity / gyro may be null (sensor missing). */
    public static final class Window {
        public final double[] ax;
        public final double[] ay;
        public final double[] az;
        /** Mean gravity-sensor vector over the window, or null (no gravity sensor). */
        public final double[] gravityMean;
        /** Gyroscope magnitude (rad/s) per grid point, or null (no gyroscope). */
        public final double[] gyro;

        public Window(double[] ax, double[] ay, double[] az, double[] gravityMean, double[] gyro) {
            this.ax = ax;
            this.ay = ay;
            this.az = az;
            this.gravityMean = gravityMean;
            this.gyro = gyro;
        }
    }

    public static final class Result {
        public Verdict verdict = Verdict.UNKNOWN;
        public String reason = "";
        public double stepFreqHz = 0;
        public double stepAutocorr = 0;
        public double strideAutocorr = Double.NaN;
        /** Autocorrelation after {@link #longLagSteps} step periods (~2.5 s), NaN if not measured. */
        public double longLagAutocorr = Double.NaN;
        public int longLagSteps = 0;
        public double intervalCv = Double.NaN;
        /**
         * Step frequency from the mean peak-to-peak interval (sub-sample precise, ~0.05 % for a
         * machine). NaN if fewer than 4 intervals. Its spread across a minute of windows tells a
         * machine (constant) from a person (cadence wanders by ~1 % or more).
         */
        public double peakFreqHz = Double.NaN;
        public double verticalShare = 0;
        public double gaitShare = 0;
        public double highFreqShare = 0;
        public double dominantFreqHz = 0;
        public double purity = 0;
        public double jerkRms = 0;
        public double rms = 0;
        public double meanAccel = 0;
        public double gyroMean = Double.NaN;
        public double gyroStd = Double.NaN;
        public boolean hasGyro = false;
        public int peaks = 0;

        public double periodicity() {
            return Double.isNaN(strideAutocorr) ? stepAutocorr : Math.max(stepAutocorr, strideAutocorr);
        }

        /** Steps per minute seen by the accelerometer (0 when no step rhythm was found). */
        public double cadenceSpm() {
            return stepFreqHz * 60.0;
        }

        static Result unknown(String reason) {
            Result r = new Result();
            r.verdict = Verdict.UNKNOWN;
            r.reason = reason;
            return r;
        }

        @Override
        public String toString() {
            return verdict + "(" + reason + ") f=" + round(stepFreqHz) + " ac=" + round(stepAutocorr) + "/" + round(strideAutocorr)
                + "/L" + longLagSteps + "=" + round(longLagAutocorr)
                + " cv=" + round(intervalCv) + " vert=" + round(verticalShare) + " gait=" + round(gaitShare)
                + " hf=" + round(highFreqShare) + " dom=" + round(dominantFreqHz) + " pur=" + round(purity)
                + " jerk=" + round(jerkRms) + " rms=" + round(rms) + " g=" + round(meanAccel)
                + " gyro=" + round(gyroMean) + "/" + round(gyroStd) + " peaks=" + peaks;
        }

        private static double round(double v) {
            return Math.round(v * 1000.0) / 1000.0;
        }
    }

    public static Result classify(Window w) {
        if (w == null || w.ax == null || w.ax.length != N || w.ay.length != N || w.az.length != N) {
            return Result.unknown("no_data");
        }
        Result r = new Result();
        double mx = mean(w.ax), my = mean(w.ay), mz = mean(w.az);
        r.meanAccel = Math.sqrt(mx * mx + my * my + mz * mz);
        if (Double.isNaN(r.meanAccel) || r.meanAccel < MIN_MEAN_ACCEL) {
            r.verdict = Verdict.UNKNOWN;
            r.reason = "gravity_unclear";
            return r;
        }

        // Gravity direction.
        double gx = mx, gy = my, gz = mz;
        if (w.gravityMean != null && w.gravityMean.length == 3) {
            double n = Math.sqrt(sq(w.gravityMean[0]) + sq(w.gravityMean[1]) + sq(w.gravityMean[2]));
            if (n > 5.0) {
                gx = w.gravityMean[0];
                gy = w.gravityMean[1];
                gz = w.gravityMean[2];
            }
        }
        double gn = Math.sqrt(gx * gx + gy * gy + gz * gz);
        gx /= gn;
        gy /= gn;
        gz /= gn;

        double[] dx = new double[N], dy = new double[N], dz = new double[N], v = new double[N];
        double etot = 0, ev = 0;
        for (int i = 0; i < N; i++) {
            dx[i] = w.ax[i] - mx;
            dy[i] = w.ay[i] - my;
            dz[i] = w.az[i] - mz;
            v[i] = dx[i] * gx + dy[i] * gy + dz[i] * gz;
            etot += dx[i] * dx[i] + dy[i] * dy[i] + dz[i] * dz[i];
            ev += v[i] * v[i];
        }
        etot /= N;
        ev /= N;
        r.rms = Math.sqrt(etot);
        r.verticalShare = etot > 1e-9 ? ev / etot : 0;

        // Gyroscope (optional).
        if (w.gyro != null && w.gyro.length == N) {
            r.hasGyro = true;
            r.gyroMean = mean(w.gyro);
            double s = 0;
            for (double g : w.gyro) s += sq(g - r.gyroMean);
            r.gyroStd = Math.sqrt(s / (N - 1));
        }

        // Jerk.
        double js = 0;
        for (int i = 1; i < N; i++) {
            js += sq(dx[i] - dx[i - 1]) + sq(dy[i] - dy[i - 1]) + sq(dz[i] - dz[i - 1]);
        }
        r.jerkRms = Math.sqrt(js / (N - 1)) * FS;

        if (r.meanAccel > MAX_MEAN_ACCEL) {
            r.verdict = Verdict.SHAKE;
            r.reason = "sustained_acceleration";
            return r;
        }
        if (r.rms < IDLE_RMS) {
            r.verdict = Verdict.IDLE;
            r.reason = "still";
            return r;
        }

        // Spectra.
        double[] hann = hann();
        double[] ptot = new double[N / 2 + 1];
        addPower(dx, hann, ptot);
        addPower(dy, hann, ptot);
        addPower(dz, hann, ptot);
        double[] pv = new double[N / 2 + 1];
        addPower(v, hann, pv);
        double eAll = bandEnergy(ptot, 0.5, 25.0);
        double eGait = bandEnergy(ptot, 0.5, 4.0);
        double eHigh = bandEnergy(ptot, 7.0, 25.0);
        r.gaitShare = eAll > 0 ? eGait / eAll : 0;
        r.highFreqShare = eAll > 0 ? eHigh / eAll : 0;
        r.dominantFreqHz = peakFrequency(ptot, 0.5, 20.0);

        // Step period from the band-limited vertical signal.
        double[] vb = bandLimit(v, 0.5, 4.5);
        int minLag = (int) Math.round(FS / 3.85);  // 13 samples
        int maxLag = (int) Math.round(FS / 0.85);  // 59 samples
        double[] ac = new double[2 * maxLag + 8];
        for (int lag = 1; lag < ac.length && lag < N - 16; lag++) {
            ac[lag] = pearsonLag(vb, lag);
        }
        int best = -1;
        for (int lag = minLag; lag <= maxLag; lag++) {
            if (isLocalMax(ac, lag) && ac[lag] > 0 && (best < 0 || ac[lag] > ac[best])) best = lag;
        }
        if (best < 0) {
            return decideNonPeriodic(r, "no_rhythm");
        }
        int stepLag = best;
        int strideLag = -1;
        int half = findLocalMaxNear(ac, best / 2.0, 3, minLag);
        if (half > 0 && ac[half] >= 0.25 && ac[half] >= 0.4 * ac[best]) {
            stepLag = half;
            strideLag = best;
        } else {
            int dbl = findLocalMaxNear(ac, best * 2.0, 3, best + 1);
            if (dbl > 0 && dbl < ac.length - 1) strideLag = dbl;
        }
        double refined = stepLag + parabolicOffset(ac[stepLag - 1], ac[stepLag], ac[stepLag + 1]);
        r.stepFreqHz = FS / refined;
        r.stepAutocorr = ac[stepLag];
        r.strideAutocorr = strideLag > 0 ? ac[strideLag] : Double.NaN;
        // Coherence over several steps (~2.5 s): human step timing wanders (errors accumulate),
        // a motor / pendulum / fan stays in phase.
        int steps = (int) Math.floor(125.0 / refined);
        if (steps >= 2) {
            r.longLagAutocorr = pearsonLag(vb, (int) Math.round(steps * refined));
            r.longLagSteps = steps;
        }

        // Step-interval variability and purity.
        r.intervalCv = intervalCv(vb, refined, r);
        int kf = (int) Math.round(r.stepFreqHz / DF);
        double ef = 0;
        for (int k = Math.max(1, kf - 1); k <= Math.min(N / 2, kf + 1); k++) ef += pv[k];
        double evAll = bandEnergy(pv, 0.5, 25.0);
        r.purity = evAll > 0 ? ef / evAll : 0;

        return decide(r);
    }

    // ── decision ─────────────────────────────────────────────────────────────

    private static Result decide(Result r) {
        // Periodic at the step lag, or (asymmetric pocket gait) clearly at the stride lag with
        // at least some step-lag correlation.
        boolean periodic = r.stepAutocorr >= 0.30
            || (!Double.isNaN(r.strideAutocorr) && r.strideAutocorr >= 0.40 && r.stepAutocorr >= 0.20);
        boolean inBand = r.stepFreqHz >= MIN_STEP_HZ && r.stepFreqHz <= MAX_STEP_HZ;

        // 1. A spinning object: large, steady rotation rate.
        if (r.hasGyro && r.gyroMean > 4.5 && r.gyroStd < 0.25 * r.gyroMean) {
            return verdict(r, Verdict.SHAKE, "rotation");
        }
        // 2. Vibration (engine, washing machine, massager): energy mostly above 7 Hz.
        if (r.highFreqShare > VIBRATION_SHARE) {
            return verdict(r, Verdict.SHAKE, "vibration");
        }
        // 3. Energy mostly outside the gait band: fast shaking.
        if (r.gaitShare < MIN_GAIT_SHARE) {
            if (r.rms >= 1.5) return verdict(r, Verdict.SHAKE, "fast_oscillation");
            return verdict(r, Verdict.UNKNOWN, "outside_gait_band");
        }
        // 4. Machine-like regularity: a motor, rocker, pendulum or fan repeats exactly.
        // Within one window only the most blatant cases (all of: near-zero interval spread,
        // near-perfect periodicity at 1 and ~5 steps, near-sine waveform). Machines that are
        // slightly less perfect are caught over a minute by EvidenceTracker (cadence steadiness).
        boolean veryRegular = !Double.isNaN(r.intervalCv) && r.intervalCv < MECHANICAL_CV;
        boolean coherent = Double.isNaN(r.longLagAutocorr) || r.longLagAutocorr >= 0.96;
        if (periodic && veryRegular && coherent && r.stepAutocorr >= 0.95 && r.purity >= 0.90) {
            return verdict(r, Verdict.SHAKE, "mechanical");
        }
        boolean chaotic = (r.hasGyro && r.gyroStd > 4.0) || r.jerkRms > 350;
        if (!periodic || !inBand) {
            return decideNonPeriodic(r, !periodic ? "not_periodic" : "cadence_out_of_range");
        }
        if (chaotic && r.periodicity() < 0.5) {
            return verdict(r, Verdict.SHAKE, "erratic");
        }
        // 5. No vertical rhythm: rocked / swung flat in the horizontal plane.
        if (r.verticalShare < 0.08) {
            return verdict(r, Verdict.SHAKE, "horizontal_oscillation");
        }
        if (r.verticalShare < 0.15) {
            return verdict(r, Verdict.UNKNOWN, "low_vertical");
        }
        if (!Double.isNaN(r.intervalCv) && r.intervalCv > MAX_HUMAN_CV) {
            return verdict(r, Verdict.UNKNOWN, "irregular");
        }
        return verdict(r, r.stepFreqHz >= RUN_STEP_HZ ? Verdict.RUNNING : Verdict.WALKING, "gait");
    }

    private static Result decideNonPeriodic(Result r, String why) {
        boolean chaotic = (r.hasGyro && r.gyroStd > 4.0) || r.jerkRms > 350;
        if (r.highFreqShare > VIBRATION_SHARE) return verdict(r, Verdict.SHAKE, "vibration");
        if (chaotic && r.rms >= 3.0) return verdict(r, Verdict.SHAKE, "erratic");
        if (r.dominantFreqHz > 3.9 && r.rms >= 2.0 && r.gaitShare < 0.5) return verdict(r, Verdict.SHAKE, "fast_oscillation");
        r.stepFreqHz = r.stepFreqHz >= MIN_STEP_HZ && r.stepFreqHz <= MAX_STEP_HZ ? r.stepFreqHz : 0;
        return verdict(r, Verdict.UNKNOWN, why);
    }

    private static Result verdict(Result r, Verdict v, String reason) {
        r.verdict = v;
        r.reason = reason;
        return r;
    }

    // ── signal helpers ───────────────────────────────────────────────────────

    /** CV of peak-to-peak intervals of the band-limited vertical signal (NaN if < 4 intervals). */
    private static double intervalCv(double[] x, double periodSamples, Result r) {
        double sd = 0;
        for (double value : x) sd += value * value;
        sd = Math.sqrt(sd / x.length);
        double threshold = 0.3 * sd;
        int minSep = (int) Math.max(3, Math.floor(0.6 * periodSamples));
        double[] peaks = new double[x.length];
        int count = 0;
        int lastIdx = -minSep - 1;
        for (int i = 4; i < x.length - 4; i++) { // skip the outermost samples (filter edge effects)
            if (x[i] > threshold && x[i] >= x[i - 1] && x[i] > x[i + 1]) {
                double t = i + parabolicOffset(x[i - 1], x[i], x[i + 1]);
                if (i - lastIdx < minSep) {
                    // keep the higher of two close peaks
                    if (count > 0 && x[i] > x[lastIdx]) {
                        peaks[count - 1] = t;
                        lastIdx = i;
                    }
                    continue;
                }
                peaks[count++] = t;
                lastIdx = i;
            }
        }
        r.peaks = count;
        double sum = 0, sumSq = 0;
        int n = 0;
        for (int i = 1; i < count; i++) {
            double interval = peaks[i] - peaks[i - 1];
            if (interval < 0.5 * periodSamples || interval > 1.6 * periodSamples) continue;
            sum += interval;
            sumSq += interval * interval;
            n++;
        }
        if (n < 4) return Double.NaN;
        double mean = sum / n;
        r.peakFreqHz = FS / mean;
        double var = Math.max(0, sumSq / n - mean * mean) * n / (n - 1.0);
        return Math.sqrt(var) / mean;
    }

    private static double pearsonLag(double[] x, int lag) {
        double sxy = 0, sxx = 0, syy = 0;
        for (int i = 0; i + lag < x.length; i++) {
            sxy += x[i] * x[i + lag];
            sxx += x[i] * x[i];
            syy += x[i + lag] * x[i + lag];
        }
        double d = Math.sqrt(sxx * syy);
        return d > 1e-12 ? sxy / d : 0;
    }

    private static boolean isLocalMax(double[] a, int i) {
        return i > 0 && i < a.length - 1 && a[i] >= a[i - 1] && a[i] >= a[i + 1];
    }

    private static int findLocalMaxNear(double[] a, double center, int radius, int minIndex) {
        int c = (int) Math.round(center);
        int best = -1;
        for (int i = c - radius; i <= c + radius; i++) {
            if (i < Math.max(1, minIndex) || i >= a.length - 1) continue;
            if (isLocalMax(a, i) && (best < 0 || a[i] > a[best])) best = i;
        }
        return best;
    }

    private static double parabolicOffset(double a, double b, double c) {
        double denom = a - 2 * b + c;
        if (Math.abs(denom) < 1e-12) return 0;
        double off = 0.5 * (a - c) / denom;
        return Math.max(-0.5, Math.min(0.5, off));
    }

    private static double[] hann() {
        double[] w = new double[N];
        for (int i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
        return w;
    }

    private static void addPower(double[] x, double[] win, double[] out) {
        double[] re = new double[N], im = new double[N];
        for (int i = 0; i < N; i++) re[i] = x[i] * win[i];
        fft(re, im, false);
        for (int k = 0; k <= N / 2; k++) out[k] += re[k] * re[k] + im[k] * im[k];
    }

    private static double bandEnergy(double[] p, double lo, double hi) {
        double e = 0;
        int k0 = (int) Math.ceil(lo / DF), k1 = (int) Math.floor(hi / DF);
        for (int k = Math.max(1, k0); k <= Math.min(p.length - 1, k1); k++) e += p[k];
        return e;
    }

    private static double peakFrequency(double[] p, double lo, double hi) {
        int k0 = (int) Math.ceil(lo / DF), k1 = (int) Math.floor(hi / DF);
        int best = -1;
        for (int k = Math.max(1, k0); k <= Math.min(p.length - 1, k1); k++) {
            if (best < 0 || p[k] > p[best]) best = k;
        }
        return best < 0 ? 0 : best * DF;
    }

    /**
     * Zero-phase band limit via an FFT mask on the mirrored (even) extension of the window, so
     * the circular filter sees no jump at the window edges (edge ringing would jitter peak times).
     */
    private static double[] bandLimit(double[] x, double lo, double hi) {
        int m = 2 * N;
        double[] re = new double[m], im = new double[m];
        for (int i = 0; i < N; i++) {
            re[i] = x[i];
            re[m - 1 - i] = x[i];
        }
        fft(re, im, false);
        double df = FS / (double) m;
        for (int k = 0; k < m; k++) {
            int kk = k <= m / 2 ? k : m - k;
            double f = kk * df;
            if (f < lo || f > hi) {
                re[k] = 0;
                im[k] = 0;
            }
        }
        fft(re, im, true);
        double[] out = new double[N];
        System.arraycopy(re, 0, out, 0, N);
        return out;
    }

    /** In-place radix-2 FFT (N must be a power of two). inverse=true scales by 1/N. */
    static void fft(double[] re, double[] im, boolean inverse) {
        int n = re.length;
        for (int i = 1, j = 0; i < n; i++) {
            int bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                double t = re[i];
                re[i] = re[j];
                re[j] = t;
                t = im[i];
                im[i] = im[j];
                im[j] = t;
            }
        }
        for (int len = 2; len <= n; len <<= 1) {
            double ang = 2 * Math.PI / len * (inverse ? 1 : -1);
            double wr = Math.cos(ang), wi = Math.sin(ang);
            for (int i = 0; i < n; i += len) {
                double cr = 1, ci = 0;
                for (int j = 0; j < len / 2; j++) {
                    int a = i + j, b = i + j + len / 2;
                    double ur = re[a], ui = im[a];
                    double vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
                    re[a] = ur + vr;
                    im[a] = ui + vi;
                    re[b] = ur - vr;
                    im[b] = ui - vi;
                    double ncr = cr * wr - ci * wi;
                    ci = cr * wi + ci * wr;
                    cr = ncr;
                }
            }
        }
        if (inverse) {
            for (int i = 0; i < n; i++) {
                re[i] /= n;
                im[i] /= n;
            }
        }
    }

    private static double mean(double[] a) {
        double s = 0;
        for (double v : a) s += v;
        return s / a.length;
    }

    private static double sq(double v) {
        return v * v;
    }
}
