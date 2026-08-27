// ZRMath — transcendental functions that match JavaScript bit-for-bit.
//
// WHY THIS FILE EXISTS
// --------------------
// V8 does not call the platform libm for Math.sin/cos/atan/atan2. It bundles
// its own port of Sun's fdlibm (v8/src/base/ieee754.cc) precisely so that
// results are identical on every platform. Apple's libm and glibc are
// different implementations, and they disagree with V8 at some inputs:
//
//     cos(5.8232818)   glibc: 0.89609533115890549482
//                      V8:    0.89609533115890560584
//
// That 1-ULP gap is harmless in world generation (~1e-14 m of drift) but fatal
// in ZRCore::SimulateAI. simulateAI3 runs ~5,400 steps of a bang-bang
// controller (`left: dyaw > 0.06`, `brake: curve > 0.30`), which is a
// positive-Lyapunov feedback loop: a 1e-16 perturbation amplifies until a
// threshold flips one step early, after which the trajectories separate
// macroscopically. Armand's finish time would drift by tens of milliseconds
// and the AI would visibly ride a different line to the browser game.
//
// So ZRCore calls ZR::Sin/Cos/Atan/Atan2 instead of std::sin/cos/atan/atan2,
// and gets bit-exact agreement with Node — which Tools/zrcore_verify.cpp
// proves on every build.
//
// sqrt, floor, fabs, fmod and trunc are correctly rounded per IEEE-754 and
// need no replacement; std:: versions of those are used directly.
//
// This is public-domain Sun Microsystems fdlibm, transcribed. Do not "clean it
// up" — the exact expression shapes and the order of operations are what make
// it bit-exact.

#pragma once

#include <cstdint>

namespace ZR
{
	// Bit-exact equivalents of JavaScript's Math.*
	double Sin(double X);
	double Cos(double X);
	double Atan(double X);
	double Atan2(double Y, double X);

	// ECMA-262 ToInt32. Needed because JavaScript's `|0` truncates a *double*,
	// which is not the same as a C++ integer cast once the value exceeds the
	// int32 range. See the hash2 comment in ZRCore.cpp — this is load-bearing.
	int32_t ToInt32(double D);

	// JavaScript's Math.round is floor(x + 0.5) (half toward +infinity).
	// C++'s std::round is half-away-from-zero. They differ at negative .5,
	// which backflips and left spins reach.
	double Round(double X);

	// JavaScript's Math.sign.
	inline double Sign(double X)
	{
		return X > 0.0 ? 1.0 : (X < 0.0 ? -1.0 : X);
	}
}
