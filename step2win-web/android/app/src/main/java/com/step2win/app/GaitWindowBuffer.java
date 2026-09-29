package com.step2win.app;

/**
 * Pure-Java sliding window for {@link GaitClassifier}: collects raw accelerometer samples
 * (with sample-and-hold gyroscope magnitude / gravity vector when those sensors exist),
 * resamples the last 5.12 s onto a uniform 50 Hz grid and classifies it every
 * {@link #HOP_MS} ms.
 *
 * Timestamps must be the SENSOR timestamps (monotonic, in ms), not the arrival time: with
 * batched sensor delivery (maxReportLatencyUs) samples arrive in bursts but keep their real
 * spacing. A gap longer than {@link #GAP_RESET_MS} restarts the window (nothing is classified
 * across a gap). Too few samples (< ~15 Hz effective) gives UNKNOWN, never SHAKE.
 */
public final class GaitWindowBuffer {
    public static final long HOP_MS = 2_500L;
    public static final long WINDOW_MS = GaitClassifier.N * 1000L / GaitClassifier.FS; // 5120
    static final long GAP_RESET_MS = 1_000L;
    static final int MIN_SAMPLES = (int) (WINDOW_MS / 1000.0 * 15); // 15 Hz effective
    private static final int CAPACITY = 2_048; // 5.12 s at up to ~400 Hz

    private final long[] t = new long[CAPACITY];
    private final float[] ax = new float[CAPACITY];
    private final float[] ay = new float[CAPACITY];
    private final float[] az = new float[CAPACITY];
    private final float[] gyro = new float[CAPACITY];
    private final float[] gx = new float[CAPACITY];
    private final float[] gy = new float[CAPACITY];
    private final float[] gz = new float[CAPACITY];
    private final boolean[] hasGyro = new boolean[CAPACITY];
    private final boolean[] hasGrav = new boolean[CAPACITY];
    private int head = 0; // index of oldest
    private int size = 0;
    private long lastT = Long.MIN_VALUE;
    private long lastEvalT = Long.MIN_VALUE;
    private long windowStartT = Long.MIN_VALUE;

    public synchronized void reset() {
        head = 0;
        size = 0;
        lastT = Long.MIN_VALUE;
        lastEvalT = Long.MIN_VALUE;
        windowStartT = Long.MIN_VALUE;
    }

    /**
     * Adds one accelerometer sample. gyroMag / gravity may be NaN when the sensor is missing
     * (or has not reported yet). Returns a classification when a window was evaluated, else null.
     */
    public synchronized GaitClassifier.Result add(long tMs, float x, float y, float z, float gyroMag, float gravX, float gravY, float gravZ) {
        if (Float.isNaN(x) || Float.isNaN(y) || Float.isNaN(z)) return null;
        if (lastT != Long.MIN_VALUE) {
            if (tMs <= lastT) return null; // out of order / duplicate
            if (tMs - lastT > GAP_RESET_MS) {
                head = 0;
                size = 0;
                lastEvalT = Long.MIN_VALUE;
                windowStartT = Long.MIN_VALUE;
            }
        }
        if (windowStartT == Long.MIN_VALUE) windowStartT = tMs;
        lastT = tMs;
        int idx;
        if (size < CAPACITY) {
            idx = (head + size) % CAPACITY;
            size++;
        } else {
            idx = head;
            head = (head + 1) % CAPACITY;
        }
        t[idx] = tMs;
        ax[idx] = x;
        ay[idx] = y;
        az[idx] = z;
        boolean g = !Float.isNaN(gyroMag);
        hasGyro[idx] = g;
        gyro[idx] = g ? gyroMag : 0f;
        boolean gr = !Float.isNaN(gravX) && !Float.isNaN(gravY) && !Float.isNaN(gravZ);
        hasGrav[idx] = gr;
        gx[idx] = gr ? gravX : 0f;
        gy[idx] = gr ? gravY : 0f;
        gz[idx] = gr ? gravZ : 0f;
        // drop samples older than the window (+ a little margin)
        while (size > 0 && t[head] < tMs - WINDOW_MS - 100) {
            head = (head + 1) % CAPACITY;
            size--;
        }
        if (tMs - windowStartT < WINDOW_MS) return null;
        if (lastEvalT != Long.MIN_VALUE && tMs - lastEvalT < HOP_MS) return null;
        lastEvalT = tMs;
        return evaluate(tMs);
    }

    private GaitClassifier.Result evaluate(long endT) {
        final int n = GaitClassifier.N;
        final double step = 1000.0 / GaitClassifier.FS;
        double start = endT - WINDOW_MS + step;
        int inWindow = 0;
        int gyroCount = 0;
        int gravCount = 0;
        double sgx = 0, sgy = 0, sgz = 0;
        for (int k = 0; k < size; k++) {
            int i = (head + k) % CAPACITY;
            if (t[i] < start - step / 2) continue;
            inWindow++;
            if (hasGyro[i]) gyroCount++;
            if (hasGrav[i]) {
                gravCount++;
                sgx += gx[i];
                sgy += gy[i];
                sgz += gz[i];
            }
        }
        if (inWindow < MIN_SAMPLES) {
            return GaitClassifier.Result.unknown("low_sample_rate");
        }
        boolean useGyro = gyroCount >= inWindow * 0.9;
        boolean useGrav = gravCount >= inWindow * 0.9;

        double[] rx = new double[n], ry = new double[n], rz = new double[n];
        double[] rg = useGyro ? new double[n] : null;
        int p = 0; // pointer (relative index) into the buffer
        for (int k = 0; k < n; k++) {
            double tk = start + k * step;
            // advance p to the first sample with t >= tk - step/2
            while (p < size && t[(head + p) % CAPACITY] < tk - step / 2) p++;
            // average samples within [tk - step/2, tk + step/2)
            double sx = 0, sy = 0, sz = 0, sg = 0;
            int c = 0;
            int q = p;
            while (q < size && t[(head + q) % CAPACITY] < tk + step / 2) {
                int i = (head + q) % CAPACITY;
                sx += ax[i];
                sy += ay[i];
                sz += az[i];
                sg += gyro[i];
                c++;
                q++;
            }
            if (c > 0) {
                rx[k] = sx / c;
                ry[k] = sy / c;
                rz[k] = sz / c;
                if (rg != null) rg[k] = sg / c;
            } else {
                // linear interpolation between the neighbours
                int after = Math.min(size - 1, p);
                int before = Math.max(0, p - 1);
                int ib = (head + before) % CAPACITY, ia = (head + after) % CAPACITY;
                double tb = t[ib], ta = t[ia];
                double f = ta > tb ? (tk - tb) / (ta - tb) : 0;
                f = Math.max(0, Math.min(1, f));
                rx[k] = ax[ib] + f * (ax[ia] - ax[ib]);
                ry[k] = ay[ib] + f * (ay[ia] - ay[ib]);
                rz[k] = az[ib] + f * (az[ia] - az[ib]);
                if (rg != null) rg[k] = gyro[ib] + f * (gyro[ia] - gyro[ib]);
            }
        }
        double[] grav = useGrav ? new double[] {sgx / gravCount, sgy / gravCount, sgz / gravCount} : null;
        return GaitClassifier.classify(new GaitClassifier.Window(rx, ry, rz, grav, rg));
    }
}
