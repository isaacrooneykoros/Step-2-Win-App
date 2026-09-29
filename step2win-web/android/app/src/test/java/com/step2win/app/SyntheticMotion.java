package com.step2win.app;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;

/**
 * Synthetic phone-motion generator for the gait classifier tests.
 *
 * World frame: x forward, y left, z up. The accelerometer measures proper acceleration
 * (linear acceleration + 9.81 m/s^2 "up"), rotated into the device frame; the gyroscope the
 * device angular velocity. Human gait models include what real gait has and machines lack:
 * step-to-step timing variability (a few %), amplitude variability, left/right asymmetry,
 * heel-strike impulses (harmonics), lateral sway at the stride frequency and a swinging thigh /
 * arm / bag that rotates the phone. Machines (shaker, rocker, pendulum, fan) repeat exactly.
 */
final class SyntheticMotion {
    static final double G = 9.81;

    /** One sensor sample in the device frame. */
    static final class Sample {
        long tMs;
        float ax, ay, az;
        float gyro = Float.NaN;               // magnitude, NaN = no gyroscope
        float gx = Float.NaN, gy = Float.NaN, gz = Float.NaN; // gravity sensor, NaN = none
    }

    interface Model {
        /** Fills device-frame proper acceleration acc[3] and gyro vector w[3] at time t (s). */
        void at(double t, double[] acc, double[] w, double[] gravityDevice);
    }

    // ── generation ───────────────────────────────────────────────────────────

    static List<Sample> generate(Model model, double seconds, double rateHz, long seed, boolean gyro, boolean gravity) {
        Random rnd = new Random(seed ^ 0x5DEECE66DL);
        List<Sample> out = new ArrayList<>();
        double dt = 1.0 / rateHz;
        double[] acc = new double[3], w = new double[3], grav = new double[3];
        long t0 = 1_000_000L;
        for (double t = 0; t < seconds; t += dt) {
            double tj = t + (rnd.nextDouble() - 0.5) * 0.004; // +-2 ms timestamp jitter
            model.at(tj, acc, w, grav);
            Sample s = new Sample();
            s.tMs = t0 + Math.round(tj * 1000.0);
            s.ax = (float) (acc[0] + rnd.nextGaussian() * 0.06);
            s.ay = (float) (acc[1] + rnd.nextGaussian() * 0.06);
            s.az = (float) (acc[2] + rnd.nextGaussian() * 0.06);
            if (gyro) {
                double wx = w[0] + rnd.nextGaussian() * 0.01, wy = w[1] + rnd.nextGaussian() * 0.01, wz = w[2] + rnd.nextGaussian() * 0.01;
                s.gyro = (float) Math.sqrt(wx * wx + wy * wy + wz * wz);
            }
            if (gravity) {
                s.gx = (float) grav[0];
                s.gy = (float) grav[1];
                s.gz = (float) grav[2];
            }
            out.add(s);
        }
        return out;
    }

    /** Feeds samples through a fresh window buffer; returns every window result. */
    static List<GaitClassifier.Result> classify(List<Sample> samples) {
        GaitWindowBuffer buffer = new GaitWindowBuffer();
        List<GaitClassifier.Result> results = new ArrayList<>();
        for (Sample s : samples) {
            GaitClassifier.Result r = buffer.add(s.tMs, s.ax, s.ay, s.az, s.gyro, s.gx, s.gy, s.gz);
            if (r != null) results.add(r);
        }
        return results;
    }

    // ── rotation helpers ─────────────────────────────────────────────────────

    /** Rotation world->device from roll (x), pitch (y), yaw (z) in radians: v_dev = R^T v_world. */
    static void toDevice(double roll, double pitch, double yaw, double[] world, double[] out) {
        double cr = Math.cos(roll), sr = Math.sin(roll);
        double cp = Math.cos(pitch), sp = Math.sin(pitch);
        double cy = Math.cos(yaw), sy = Math.sin(yaw);
        // R = Rz(yaw) * Ry(pitch) * Rx(roll): device->world. Device = R^T * world.
        double r00 = cy * cp, r01 = cy * sp * sr - sy * cr, r02 = cy * sp * cr + sy * sr;
        double r10 = sy * cp, r11 = sy * sp * sr + cy * cr, r12 = sy * sp * cr - cy * sr;
        double r20 = -sp, r21 = cp * sr, r22 = cp * cr;
        double x = world[0], y = world[1], z = world[2];
        out[0] = r00 * x + r10 * y + r20 * z;
        out[1] = r01 * x + r11 * y + r21 * z;
        out[2] = r02 * x + r12 * y + r22 * z;
    }

    // ── human gait ───────────────────────────────────────────────────────────

    /** Step times with natural variability (cv), left/right asymmetry. */
    static final class StepClock {
        final double[] times;

        StepClock(double cadenceSpm, double seconds, double cv, double asym, Random rnd) {
            double period = 60.0 / cadenceSpm;
            List<Double> ts = new ArrayList<>();
            double t = -2 * period + rnd.nextDouble() * period;
            int k = 0;
            // slow cadence drift (terrain, pace) plus step-to-step noise
            double drift = 0;
            while (t < seconds + 3 * period) {
                ts.add(t);
                drift = 0.97 * drift + rnd.nextGaussian() * 0.004;
                double p = period * (1 + drift + cv * rnd.nextGaussian()) * ((k % 2 == 0) ? (1 + asym) : (1 - asym));
                t += Math.max(0.2 * period, p);
                k++;
            }
            times = new double[ts.size()];
            for (int i = 0; i < times.length; i++) times[i] = ts.get(i);
        }

        /** Continuous step phase: index + fraction. */
        double phase(double t) {
            int lo = 0, hi = times.length - 1;
            if (t <= times[0]) return 0;
            if (t >= times[hi]) return hi;
            while (hi - lo > 1) {
                int mid = (lo + hi) >>> 1;
                if (times[mid] <= t) lo = mid;
                else hi = mid;
            }
            return lo + (t - times[lo]) / (times[lo + 1] - times[lo]);
        }

        int index(double t) {
            return (int) Math.floor(phase(t));
        }
    }

    enum Carry { POCKET, HAND_TEXTING, HAND_SWINGING, BAG }

    static Model walk(final double cadenceSpm, final Carry carry, final double seconds, long seed) {
        return gait(cadenceSpm, carry, seconds, seed, false);
    }

    static Model run(final double cadenceSpm, final Carry carry, final double seconds, long seed) {
        return gait(cadenceSpm, carry, seconds, seed, true);
    }

    private static Model gait(final double cadenceSpm, final Carry carry, final double seconds, long seed, final boolean running) {
        final Random rnd = new Random(seed);
        final StepClock clock = new StepClock(cadenceSpm, seconds, running ? 0.022 : 0.03, running ? 0.012 : 0.02, rnd);
        final double[] amp = new double[clock.times.length];
        for (int i = 0; i < amp.length; i++) amp[i] = (1 + 0.1 * rnd.nextGaussian()) * (i % 2 == 0 ? 1.0 : 0.85);
        final double period = 60.0 / cadenceSpm;
        // carry-dependent parameters
        final double impact, sigma, fwd, lat, swingAngle, baseRoll, basePitch, baseYaw, wobble;
        switch (carry) {
            case POCKET:
                impact = running ? 22 : 7.0; sigma = running ? 0.035 : 0.06; fwd = running ? 4 : 2.0; lat = running ? 2 : 1.0;
                swingAngle = running ? 0.55 : 0.30; baseRoll = 1.35; basePitch = 0.2; baseYaw = 0.4; wobble = 0.02;
                break;
            case HAND_TEXTING:
                impact = running ? 9 : 3.0; sigma = running ? 0.05 : 0.09; fwd = running ? 2.5 : 1.2; lat = running ? 1.2 : 0.6;
                swingAngle = 0.05; baseRoll = 0.7; basePitch = 0.05; baseYaw = 0.1; wobble = 0.03;
                break;
            case HAND_SWINGING:
                impact = running ? 12 : 3.5; sigma = running ? 0.045 : 0.07; fwd = running ? 7 : 4.5; lat = running ? 1.5 : 0.8;
                swingAngle = running ? 0.8 : 0.6; baseRoll = 0.1; basePitch = 0.0; baseYaw = 1.2; wobble = 0.03;
                break;
            default: // BAG
                impact = running ? 10 : 2.6; sigma = running ? 0.06 : 0.10; fwd = running ? 2 : 0.8; lat = running ? 1.5 : 0.9;
                swingAngle = 0.12; baseRoll = 1.57; basePitch = 0.6; baseYaw = 2.0; wobble = 0.04;
                break;
        }
        final double wobblePhase = rnd.nextDouble() * 6.28;
        return new Model() {
            final double[] world = new double[3];
            final double[] gw = new double[] {0, 0, G};

            @Override
            public void at(double t, double[] acc, double[] w, double[] gravDev) {
                double p = clock.phase(t);
                int k = (int) Math.floor(p);
                double vert = 0;
                for (int j = Math.max(0, k - 2); j <= Math.min(clock.times.length - 1, k + 2); j++) {
                    double dtj = t - clock.times[j];
                    vert += amp[j] * impact * Math.exp(-0.5 * sq(dtj / sigma));
                    if (running) {
                        // flight phase: nearly free fall between impacts
                        vert -= amp[j] * 0.45 * impact * Math.exp(-0.5 * sq((dtj - 0.55 * period) / (0.2 * period)));
                    } else {
                        vert -= amp[j] * 0.35 * impact * Math.exp(-0.5 * sq((dtj - 0.45 * period) / (0.18 * period)));
                    }
                }
                double forward = fwd * Math.sin(2 * Math.PI * p + 0.8);
                double lateral = lat * Math.sin(Math.PI * p);
                double swing = swingAngle * Math.sin(Math.PI * p); // thigh / arm / bag swing at stride frequency
                double swingRate = swingAngle * Math.PI / period * Math.cos(Math.PI * p);
                if (carry == Carry.HAND_SWINGING) {
                    // arm pendulum: tangential (forward) + centripetal (up along the arm)
                    forward += fwd * Math.cos(Math.PI * p);
                    vert += 0.6 * fwd * sq(Math.cos(Math.PI * p));
                }
                world[0] = forward;
                world[1] = lateral;
                world[2] = vert;
                double roll = baseRoll + wobble * Math.sin(2 * Math.PI * 0.7 * t + wobblePhase);
                double pitch = basePitch + swing;
                double yaw = baseYaw;
                double[] tmp = new double[3];
                double[] total = new double[] {world[0] + gw[0], world[1] + gw[1], world[2] + gw[2]};
                toDevice(roll, pitch, yaw, total, acc);
                toDevice(roll, pitch, yaw, gw, gravDev);
                // angular velocity: swing about the (rotated) pitch axis + small wobble
                w[0] = wobble * 2 * Math.PI * 0.7 * Math.cos(2 * Math.PI * 0.7 * t + wobblePhase);
                w[1] = swingRate;
                w[2] = 0.15 * Math.sin(2 * Math.PI * p);
                if (carry == Carry.POCKET) w[2] += 0.4 * Math.sin(Math.PI * p + 0.3);
                toDevice(0, 0, 0, w, tmp);
            }
        };
    }

    // ── not walking ──────────────────────────────────────────────────────────

    /** Vigorous hand shaking: 3.5-6.5 Hz, wandering frequency, direction and orientation. */
    static Model handShake(final long seed) {
        final Random rnd = new Random(seed);
        return new Model() {
            double lastT = 0, phase = 0, f = 4.5, amp = 16;
            double dx = 0.3, dy = 0.8, dz = 0.5;
            double roll = 0.3, pitch = 0.2, yaw = 0, rotPhase = 0;
            final double[] ax = new double[] {0.6, 0.3, 0.7};

            @Override
            public void at(double t, double[] acc, double[] w, double[] gravDev) {
                double dt = Math.max(0, t - lastT);
                lastT = t;
                f = clamp(f + rnd.nextGaussian() * 0.12, 3.6, 6.5);
                amp = clamp(amp + rnd.nextGaussian() * 0.6, 10, 26);
                dx += rnd.nextGaussian() * 0.06;
                dy += rnd.nextGaussian() * 0.06;
                dz += rnd.nextGaussian() * 0.06;
                double n = Math.sqrt(dx * dx + dy * dy + dz * dz);
                dx /= n; dy /= n; dz /= n;
                phase += 2 * Math.PI * f * dt;
                double a = amp * Math.sin(phase);
                double dr = rnd.nextGaussian() * 0.02, dp = rnd.nextGaussian() * 0.02, dyw = rnd.nextGaussian() * 0.02;
                roll = clamp(roll + dr, -0.9, 0.9);
                pitch = clamp(pitch + dp, -0.9, 0.9);
                yaw += dyw;
                double wrist = 0.35 * Math.sin(phase + 0.7); // wrist rotation with each shake
                double[] world = new double[] {a * dx, a * dy, a * dz + G};
                toDevice(roll + wrist * ax[0], pitch + wrist * ax[1], yaw + wrist * ax[2], world, acc);
                toDevice(roll + wrist * ax[0], pitch + wrist * ax[1], yaw + wrist * ax[2], new double[] {0, 0, G}, gravDev);
                double wr = 0.35 * 2 * Math.PI * f * Math.cos(phase + 0.7);
                double safeDt = dt > 0 ? dt : 0.02;
                w[0] = wr * ax[0] + dr / safeDt;
                w[1] = wr * ax[1] + dp / safeDt;
                w[2] = wr * ax[2] + dyw / safeDt;
            }
        };
    }

    /** Motorised shaker moving the phone up and down (vertical axis!) at a fixed rate. */
    static Model verticalShaker(final double hz, final double amplitudeM) {
        return new Model() {
            @Override
            public void at(double t, double[] acc, double[] w, double[] gravDev) {
                // motor speed drifts 0.1 % (slowly); phase is the integral of the frequency
                double drift = 0.001;
                double phase = 2 * Math.PI * hz * (t - drift / (2 * Math.PI * 0.05) * Math.cos(2 * Math.PI * 0.05 * t));
                double om = 2 * Math.PI * hz;
                double a = -amplitudeM * om * om * Math.sin(phase);
                a += 0.08 * amplitudeM * om * om * Math.sin(2 * phase); // end-stop harmonic
                double[] world = new double[] {0.05 * a, 0, a + G};
                toDevice(0.9, 0.1, 0.3, world, acc);
                toDevice(0.9, 0.1, 0.3, new double[] {0, 0, G}, gravDev);
                w[0] = 0.02; w[1] = 0.01; w[2] = 0.0;
            }
        };
    }

    /** Rocking cradle: rotates the phone +-angle about a horizontal pivot below it. */
    static Model rocker(final double hz, final double angle, final double radiusM) {
        return new Model() {
            @Override
            public void at(double t, double[] acc, double[] w, double[] gravDev) {
                double om = 2 * Math.PI * hz;
                double th = angle * Math.sin(om * t);
                double thd = angle * om * Math.cos(om * t);
                double thdd = -angle * om * om * Math.sin(om * t);
                double axw = radiusM * (thdd * Math.cos(th) - thd * thd * Math.sin(th));
                double azw = radiusM * (-thdd * Math.sin(th) - thd * thd * Math.cos(th));
                double[] world = new double[] {axw, 0, azw + G};
                toDevice(0, th, 0, world, acc);
                toDevice(0, th, 0, new double[] {0, 0, G}, gravDev);
                w[0] = 0; w[1] = thd; w[2] = 0;
            }
        };
    }

    /** Phone hanging on a string (or a fan pull chain), swinging like a pendulum. */
    static Model pendulum(final double lengthM, final double angle) {
        final double om = Math.sqrt(G / lengthM);
        return new Model() {
            @Override
            public void at(double t, double[] acc, double[] w, double[] gravDev) {
                double a = angle * (1 - 0.06 * Math.sin(2 * Math.PI * 0.04 * t)); // slow push / decay cycle
                double th = a * Math.sin(om * t);
                double thd = a * om * Math.cos(om * t);
                // proper acceleration is along the string (device y) = g cos(th) + L thd^2
                acc[0] = 0.08 * Math.sin(om * t + 0.4); // small imperfection
                acc[1] = G * Math.cos(th) + lengthM * thd * thd;
                acc[2] = 0.05 * Math.sin(0.3 * t);
                gravDev[0] = G * Math.sin(th);
                gravDev[1] = G * Math.cos(th);
                gravDev[2] = 0;
                w[0] = 0; w[1] = 0; w[2] = thd;
            }
        };
    }

    /** Phone taped to a ceiling fan blade at radius r (m), rotating at rpm. */
    static Model ceilingFan(final double rpm, final double radiusM) {
        final double om = 2 * Math.PI * rpm / 60.0;
        return new Model() {
            @Override
            public void at(double t, double[] acc, double[] w, double[] gravDev) {
                acc[0] = om * om * radiusM + 1.2 * Math.sin(om * t);   // centripetal + imbalance wobble
                acc[1] = 1.0 * Math.cos(om * t);
                acc[2] = G + 0.8 * Math.sin(om * t + 0.5);            // blade flutter
                gravDev[0] = 0; gravDev[1] = 0; gravDev[2] = G;
                w[0] = 0.05 * Math.sin(om * t); w[1] = 0.05 * Math.cos(om * t); w[2] = om;
            }
        };
    }

    /** Phone lying on a washing machine during the spin cycle (~800 rpm) with drum imbalance. */
    static Model washingMachine(final long seed) {
        final Random rnd = new Random(seed);
        return new Model() {
            @Override
            public void at(double t, double[] acc, double[] w, double[] gravDev) {
                double f = 13.3 + 0.2 * Math.sin(2 * Math.PI * 0.1 * t);
                double ph = 2 * Math.PI * f * t;
                acc[0] = 1.6 * Math.sin(ph) + 0.3 * Math.sin(2 * Math.PI * 1.1 * t) + 0.2 * rnd.nextGaussian();
                acc[1] = 1.3 * Math.sin(ph + 1.0) + 0.2 * rnd.nextGaussian();
                acc[2] = G + 2.4 * Math.sin(ph + 0.3) + 0.3 * rnd.nextGaussian();
                gravDev[0] = 0; gravDev[1] = 0; gravDev[2] = G;
                w[0] = 0.2 * Math.sin(ph); w[1] = 0.15 * Math.cos(ph); w[2] = 0.02;
            }
        };
    }

    /** Phone in a dashboard mount: engine vibration + random road bumps. */
    static Model dashboard(final long seed) {
        final Random rnd = new Random(seed);
        return new Model() {
            double lastT = 0, bumpV = 0, bumpH = 0;

            @Override
            public void at(double t, double[] acc, double[] w, double[] gravDev) {
                double dt = Math.max(0.001, t - lastT);
                lastT = t;
                double k = Math.exp(-dt * 2 * Math.PI * 2.0); // ~2 Hz low-pass road noise
                bumpV = k * bumpV + Math.sqrt(1 - k * k) * rnd.nextGaussian() * 0.9;
                bumpH = k * bumpH + Math.sqrt(1 - k * k) * rnd.nextGaussian() * 0.5;
                double engine = 0.6 * Math.sin(2 * Math.PI * 28 * t) + 0.3 * Math.sin(2 * Math.PI * 56 * t + 1);
                double[] world = new double[] {bumpH + 0.2 * engine, 0.2 * rnd.nextGaussian(), bumpV + engine + G};
                toDevice(1.2, 0.0, 0.0, world, acc);
                toDevice(1.2, 0.0, 0.0, new double[] {0, 0, G}, gravDev);
                w[0] = 0.05 * rnd.nextGaussian(); w[1] = 0.05 * rnd.nextGaussian(); w[2] = 0.08 * Math.sin(0.2 * t);
            }
        };
    }

    /** Phone lying on a table. */
    static Model still() {
        return (t, acc, w, gravDev) -> {
            acc[0] = 0.02; acc[1] = 0.03; acc[2] = G;
            gravDev[0] = 0; gravDev[1] = 0; gravDev[2] = G;
            w[0] = 0; w[1] = 0; w[2] = 0;
        };
    }

    private static double sq(double v) {
        return v * v;
    }

    private static double clamp(double v, double lo, double hi) {
        return Math.max(lo, Math.min(hi, v));
    }
}
