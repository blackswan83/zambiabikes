// ZRMath — see ZRMath.h for why this exists.
//
// Transcribed from Sun Microsystems' fdlibm, which is what V8 bundles as
// v8/src/base/ieee754.cc. Public domain:
//
//   Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
//   Developed at SunSoft, a Sun Microsystems, Inc. business.
//   Permission to use, copy, modify, and distribute this software is freely
//   granted, provided that this notice is preserved.
//
// DO NOT REFACTOR. Every parenthesis here is load-bearing: floating-point
// addition is not associative, so regrouping an expression changes the result.

#include "ZRMath.h"

#include <cmath>
#include <cstring>

// Contraction would fuse `a*b + c` into an FMA, rounding once instead of
// twice, and silently change results.
#if defined(__clang__)
#pragma clang fp contract(off)
#elif defined(__GNUC__)
#pragma GCC optimize("fp-contract=off")
#endif

namespace
{
	// ---- IEEE-754 word access -------------------------------------------
	// memcpy, not a union or a pointer cast: those are strict-aliasing UB and
	// clang will exploit them at -O2.

	inline int32_t HighWord(double D)
	{
		uint64_t Bits;
		std::memcpy(&Bits, &D, sizeof(Bits));
		return static_cast<int32_t>(static_cast<uint32_t>(Bits >> 32));
	}

	inline uint32_t LowWord(double D)
	{
		uint64_t Bits;
		std::memcpy(&Bits, &D, sizeof(Bits));
		return static_cast<uint32_t>(Bits & 0xFFFFFFFFu);
	}

	inline double FromWords(uint32_t High, uint32_t Low)
	{
		const uint64_t Bits = (static_cast<uint64_t>(High) << 32) | Low;
		double D;
		std::memcpy(&D, &Bits, sizeof(D));
		return D;
	}

	inline double WithHighWord(double D, uint32_t High)
	{
		return FromWords(High, LowWord(D));
	}

	constexpr double kZero = 0.0;
	constexpr double kOne  = 1.0;
	constexpr double kHalf = 0.5;
	constexpr double kTwo24 = 1.67772160000000000000e+07;
	constexpr double kTwoN24 = 5.96046447753906250000e-08;

	// ---- __kernel_sin: sin(x + y) for |x| <= pi/4 ------------------------

	constexpr double S1 = -1.66666666666666324348e-01;
	constexpr double S2 =  8.33333333332248946124e-03;
	constexpr double S3 = -1.98412698298579493134e-04;
	constexpr double S4 =  2.75573137070700676789e-06;
	constexpr double S5 = -2.50507602534068634195e-08;
	constexpr double S6 =  1.58969099521155010221e-10;

	double KernelSin(double X, double Y, int IY)
	{
		const int32_t IX = HighWord(X) & 0x7FFFFFFF;
		if (IX < 0x3E400000)                       // |x| < 2**-27
		{
			if (static_cast<int>(X) == 0) return X;
		}
		const double Z = X * X;
		const double V = Z * X;
		const double R = S2 + Z * (S3 + Z * (S4 + Z * (S5 + Z * S6)));
		if (IY == 0) return X + V * (S1 + Z * R);
		return X - ((Z * (kHalf * Y - V * R) - Y) - V * S1);
	}

	// ---- __kernel_cos: cos(x + y) for |x| <= pi/4 ------------------------

	constexpr double C1 =  4.16666666666666019037e-02;
	constexpr double C2 = -1.38888888888741095749e-03;
	constexpr double C3 =  2.48015872894767294178e-05;
	constexpr double C4 = -2.75573143513906633035e-07;
	constexpr double C5 =  2.08757232129817482790e-09;
	constexpr double C6 = -1.13596475577881948265e-11;

	double KernelCos(double X, double Y)
	{
		const int32_t IX = HighWord(X) & 0x7FFFFFFF;
		if (IX < 0x3E400000)                       // |x| < 2**-27
		{
			if (static_cast<int>(X) == 0) return kOne;
		}
		const double Z = X * X;
		const double R = Z * (C1 + Z * (C2 + Z * (C3 + Z * (C4 + Z * (C5 + Z * C6)))));
		if (IX < 0x3FD33333)                       // |x| < 0.3
		{
			return kOne - (0.5 * Z - (Z * R - X * Y));
		}

		double QX;
		if (IX > 0x3FE90000)                       // |x| > 0.78125
		{
			QX = 0.28125;
		}
		else
		{
			QX = FromWords(static_cast<uint32_t>(IX - 0x00200000), 0);  // x/4
		}
		const double HZ = 0.5 * Z - QX;
		const double A  = kOne - QX;
		return A - (HZ - (Z * R - X * Y));
	}

	// ---- __kernel_rem_pio2 -----------------------------------------------
	// Only reached for |x| > 2^19*(pi/2) ~= 823550. Zambia Rush never gets
	// near that (largest argument is ~65), but a game that silently produced
	// wrong answers outside its tested range would be a bad thing to leave
	// lying around, so the full reduction is here and the verify harness
	// exercises it.

	const int32_t kTwoOverPi[] = {
		0xA2F983, 0x6E4E44, 0x1529FC, 0x2757D1, 0xF534DD, 0xC0DB62,
		0x95993C, 0x439041, 0xFE5163, 0xABDEBB, 0xC561B7, 0x246E3A,
		0x424DD2, 0xE00649, 0x2EEA09, 0xD1921C, 0xFE1DEB, 0x1CB129,
		0xA73EE8, 0x8235F5, 0x2EBB44, 0x84E99C, 0x7026B4, 0x5F7E41,
		0x3991D6, 0x398353, 0x39F49C, 0x845F8B, 0xBDF928, 0x3B1FF8,
		0x97FFDE, 0x05980F, 0xEF2F11, 0x8B5A0A, 0x6D1F6D, 0x367ECF,
		0x27CB09, 0xB74F46, 0x3F669E, 0x5FEA2D, 0x7527BA, 0xC7EBE5,
		0xF17B3D, 0x0739F7, 0x8A5292, 0xEA6BFB, 0x5FB11F, 0x8D5D08,
		0x560330, 0x46FC7B, 0x6BABF0, 0xCFBC20, 0x9AF436, 0x1DA9E3,
		0x91615E, 0xE61B08, 0x659985, 0x5F14A0, 0x68408D, 0xFFD880,
		0x4D7327, 0x310606, 0x1556CA, 0x73A8C9, 0x60E27B, 0xC08C6B,
	};

	const double kPIo2[] = {
		1.57079625129699707031e+00,
		7.54978941586159635335e-08,
		5.39030252995776476554e-15,
		3.28200341580791294123e-22,
		1.27065575308067607349e-29,
		1.22933308981111328932e-36,
		2.73370053816464559624e-44,
		2.16741683877804819444e-51,
	};

	const int kInitJk[] = { 2, 3, 4, 6 };

	int KernelRemPio2(const double* X, double* Y, int E0, int NX, int Prec)
	{
		int JZ, JX, JV, JP, JK, Carry, N, IQ[20] = {}, I, J, K, M, Q0, IH;
		// Zero-initialised only to quiet -Wmaybe-uninitialized; fdlibm fills
		// every element it reads. Unreal builds warnings-as-errors in some
		// configurations, and this costs nothing.
		double Z, FW, F[20] = {}, FQ[20] = {}, Q[20] = {};

		JK = kInitJk[Prec];
		JP = JK;

		JX = NX - 1;
		JV = (E0 - 3) / 24; if (JV < 0) JV = 0;
		Q0 = E0 - 24 * (JV + 1);

		J = JV - JX; M = JX + JK;
		for (I = 0; I <= M; I++, J++)
		{
			F[I] = (J < 0) ? kZero : static_cast<double>(kTwoOverPi[J]);
		}

		for (I = 0; I <= JK; I++)
		{
			for (J = 0, FW = 0.0; J <= JX; J++) FW += X[J] * F[JX + I - J];
			Q[I] = FW;
		}

		JZ = JK;

	recompute:
		for (I = 0, J = JZ, Z = Q[JZ]; J > 0; I++, J--)
		{
			FW = static_cast<double>(static_cast<int32_t>(kTwoN24 * Z));
			IQ[I] = static_cast<int32_t>(Z - kTwo24 * FW);
			Z = Q[J - 1] + FW;
		}

		Z = std::scalbn(Z, Q0);
		Z -= 8.0 * std::floor(Z * 0.125);
		N = static_cast<int>(Z);
		Z -= static_cast<double>(N);
		IH = 0;
		if (Q0 > 0)
		{
			I = (IQ[JZ - 1] >> (24 - Q0)); N += I;
			IQ[JZ - 1] -= I << (24 - Q0);
			IH = IQ[JZ - 1] >> (23 - Q0);
		}
		else if (Q0 == 0) IH = IQ[JZ - 1] >> 23;
		else if (Z >= 0.5) IH = 2;

		if (IH > 0)
		{
			N += 1; Carry = 0;
			for (I = 0; I < JZ; I++)
			{
				J = IQ[I];
				if (Carry == 0)
				{
					if (J != 0) { Carry = 1; IQ[I] = 0x1000000 - J; }
				}
				else IQ[I] = 0xFFFFFF - J;
			}
			if (Q0 > 0)
			{
				switch (Q0)
				{
				case 1: IQ[JZ - 1] &= 0x7FFFFF; break;
				case 2: IQ[JZ - 1] &= 0x3FFFFF; break;
				default: break;
				}
			}
			if (IH == 2)
			{
				Z = kOne - Z;
				if (Carry != 0) Z -= std::scalbn(kOne, Q0);
			}
		}

		if (Z == kZero)
		{
			J = 0;
			for (I = JZ - 1; I >= JK; I--) J |= IQ[I];
			if (J == 0)
			{
				for (K = 1; IQ[JK - K] == 0; K++) {}
				for (I = JZ + 1; I <= JZ + K; I++)
				{
					F[JX + I] = static_cast<double>(kTwoOverPi[JV + I]);
					for (J = 0, FW = 0.0; J <= JX; J++) FW += X[J] * F[JX + I - J];
					Q[I] = FW;
				}
				JZ += K;
				goto recompute;
			}
		}

		if (Z == 0.0)
		{
			JZ -= 1; Q0 -= 24;
			while (IQ[JZ] == 0) { JZ--; Q0 -= 24; }
		}
		else
		{
			Z = std::scalbn(Z, -Q0);
			if (Z >= kTwo24)
			{
				FW = static_cast<double>(static_cast<int32_t>(kTwoN24 * Z));
				IQ[JZ] = static_cast<int32_t>(Z - kTwo24 * FW);
				JZ += 1; Q0 += 24;
				IQ[JZ] = static_cast<int32_t>(FW);
			}
			else IQ[JZ] = static_cast<int32_t>(Z);
		}

		FW = std::scalbn(kOne, Q0);
		for (I = JZ; I >= 0; I--)
		{
			Q[I] = FW * static_cast<double>(IQ[I]); FW *= kTwoN24;
		}

		for (I = JZ; I >= 0; I--)
		{
			for (FW = 0.0, K = 0; K <= JP && K <= JZ - I; K++) FW += kPIo2[K] * Q[I + K];
			FQ[JZ - I] = FW;
		}

		// Prec 2 is the only case sin/cos need.
		FW = 0.0;
		for (I = JZ; I >= 0; I--) FW += FQ[I];
		Y[0] = (IH == 0) ? FW : -FW;
		FW = FQ[0] - FW;
		for (I = 1; I <= JZ; I++) FW += FQ[I];
		Y[1] = (IH == 0) ? FW : -FW;

		return N & 7;
	}

	// ---- __ieee754_rem_pio2 ----------------------------------------------

	constexpr double kInvPio2 = 6.36619772367581382433e-01;
	constexpr double kPio2_1  = 1.57079632673412561417e+00;
	constexpr double kPio2_1t = 6.07710050650619224932e-11;
	constexpr double kPio2_2  = 6.07710050630396597660e-11;
	constexpr double kPio2_2t = 2.02226624879595063154e-21;
	constexpr double kPio2_3  = 2.02226624871116645580e-21;
	constexpr double kPio2_3t = 8.47842766036889956997e-32;

	int RemPio2(double X, double* Y)
	{
		double Z, W, T, R, FN;
		double TX[3];
		int E0, I, J, NX, N;

		const int32_t HX = HighWord(X);
		const int32_t IX = HX & 0x7FFFFFFF;

		if (IX <= 0x3FE921FB) { Y[0] = X; Y[1] = 0; return 0; }   // |x| <= pi/4

		if (IX < 0x4002D97C)                                      // |x| < 3pi/4
		{
			if (HX > 0)
			{
				Z = X - kPio2_1;
				if (IX != 0x3FF921FB)
				{
					Y[0] = Z - kPio2_1t;
					Y[1] = (Z - Y[0]) - kPio2_1t;
				}
				else
				{
					Z -= kPio2_2;
					Y[0] = Z - kPio2_2t;
					Y[1] = (Z - Y[0]) - kPio2_2t;
				}
				return 1;
			}
			Z = X + kPio2_1;
			if (IX != 0x3FF921FB)
			{
				Y[0] = Z + kPio2_1t;
				Y[1] = (Z - Y[0]) + kPio2_1t;
			}
			else
			{
				Z += kPio2_2;
				Y[0] = Z + kPio2_2t;
				Y[1] = (Z - Y[0]) + kPio2_2t;
			}
			return -1;
		}

		if (IX <= 0x413921FB)                                     // |x| <= 2^19*(pi/2)
		{
			T = std::fabs(X);
			N = static_cast<int>(T * kInvPio2 + kHalf);
			FN = static_cast<double>(N);
			R = T - FN * kPio2_1;
			W = FN * kPio2_1t;
			J = IX >> 20;
			Y[0] = R - W;
			I = J - ((HighWord(Y[0]) >> 20) & 0x7FF);
			if (I > 16)
			{
				T = R;
				W = FN * kPio2_2;
				R = T - W;
				W = FN * kPio2_2t - ((T - R) - W);
				Y[0] = R - W;
				I = J - ((HighWord(Y[0]) >> 20) & 0x7FF);
				if (I > 49)
				{
					T = R;
					W = FN * kPio2_3;
					R = T - W;
					W = FN * kPio2_3t - ((T - R) - W);
					Y[0] = R - W;
				}
			}
			Y[1] = (R - Y[0]) - W;
			if (HX < 0) { Y[0] = -Y[0]; Y[1] = -Y[1]; return -N; }
			return N;
		}

		if (IX >= 0x7FF00000) { Y[0] = Y[1] = X - X; return 0; }  // inf or NaN

		// set Z = scalbn(|x|, ilogb(x) - 23)
		E0 = (IX >> 20) - 1046;
		Z = FromWords(static_cast<uint32_t>(IX - (E0 << 20)), LowWord(X));
		for (I = 0; I < 2; I++)
		{
			TX[I] = static_cast<double>(static_cast<int32_t>(Z));
			Z = (Z - TX[I]) * kTwo24;
		}
		TX[2] = Z;
		NX = 3;
		while (TX[NX - 1] == kZero) NX--;
		N = KernelRemPio2(TX, Y, E0, NX, 2);
		if (HX < 0) { Y[0] = -Y[0]; Y[1] = -Y[1]; return -N; }
		return N;
	}

	// ---- __ieee754_atan ---------------------------------------------------

	const double kAtanHi[] = {
		4.63647609000806093515e-01,   // atan(0.5)hi
		7.85398163397448278999e-01,   // atan(1.0)hi
		9.82793723247329054082e-01,   // atan(1.5)hi
		1.57079632679489655800e+00,   // atan(inf)hi
	};

	const double kAtanLo[] = {
		2.26987774529616870924e-17,
		3.06161699786838301793e-17,
		1.39033110312309984516e-17,
		6.12323399573676603587e-17,
	};

	const double kAT[] = {
		 3.33333333333329318027e-01,
		-1.99999999998764832476e-01,
		 1.42857142725034663711e-01,
		-1.11111104054623557880e-01,
		 9.09088713343650656196e-02,
		-7.69187620504482999495e-02,
		 6.66107313738753120669e-02,
		-5.83357013379057348645e-02,
		 4.97687799461593236017e-02,
		-3.65315727442169155270e-02,
		 1.62858201153657823623e-02,
	};

	double AtanImpl(double X)
	{
		double W, S1v, S2v, Z;
		int ID;

		const int32_t HX = HighWord(X);
		const int32_t IX = HX & 0x7FFFFFFF;

		if (IX >= 0x44100000)                     // |x| >= 2^66
		{
			if (IX > 0x7FF00000 || (IX == 0x7FF00000 && LowWord(X) != 0)) return X + X;
			return (HX > 0) ? (kAtanHi[3] + kAtanLo[3]) : (-kAtanHi[3] - kAtanLo[3]);
		}

		if (IX < 0x3FDC0000)                      // |x| < 0.4375
		{
			if (IX < 0x3E200000) return X;        // |x| < 2^-29
			ID = -1;
		}
		else
		{
			X = std::fabs(X);
			if (IX < 0x3FF30000)                  // |x| < 1.1875
			{
				if (IX < 0x3FE60000) { ID = 0; X = (2.0 * X - kOne) / (2.0 + X); }
				else                 { ID = 1; X = (X - kOne) / (X + kOne); }
			}
			else
			{
				if (IX < 0x40038000) { ID = 2; X = (X - 1.5) / (kOne + 1.5 * X); }
				else                 { ID = 3; X = -1.0 / X; }
			}
		}

		Z = X * X;
		W = Z * Z;
		S1v = Z * (kAT[0] + W * (kAT[2] + W * (kAT[4] + W * (kAT[6] + W * (kAT[8] + W * kAT[10])))));
		S2v = W * (kAT[1] + W * (kAT[3] + W * (kAT[5] + W * (kAT[7] + W * kAT[9]))));
		if (ID < 0) return X - X * (S1v + S2v);
		Z = kAtanHi[ID] - ((X * (S1v + S2v) - kAtanLo[ID]) - X);
		return (HX < 0) ? -Z : Z;
	}

	// ---- __ieee754_atan2 --------------------------------------------------

	constexpr double kTiny  = 1.0e-300;
	constexpr double kPiO4  = 7.8539816339744827900e-01;
	constexpr double kPiO2  = 1.5707963267948965580e+00;
	constexpr double kPi    = 3.1415926535897931160e+00;
	constexpr double kPiLo  = 1.2246467991473531772e-16;

	double Atan2Impl(double Y, double X)
	{
		double Z;
		int K, M;

		const int32_t HX = HighWord(X); const int32_t IX = HX & 0x7FFFFFFF;
		const uint32_t LX = LowWord(X);
		const int32_t HY = HighWord(Y); const int32_t IY = HY & 0x7FFFFFFF;
		const uint32_t LY = LowWord(Y);

		// NaN in either argument
		if (((static_cast<uint32_t>(IX) | ((LX | (0u - LX)) >> 31)) > 0x7FF00000u) ||
			((static_cast<uint32_t>(IY) | ((LY | (0u - LY)) >> 31)) > 0x7FF00000u))
		{
			return X + Y;
		}

		if (((HX - 0x3FF00000) | static_cast<int32_t>(LX)) == 0) return AtanImpl(Y);   // x == 1.0

		M = ((HY >> 31) & 1) | ((HX >> 30) & 2);   // 2*sign(x) + sign(y)

		if ((static_cast<uint32_t>(IY) | LY) == 0)                 // y == 0
		{
			switch (M)
			{
			case 0:
			case 1:  return Y;
			case 2:  return  kPi + kTiny;
			default: return -kPi - kTiny;
			}
		}

		if ((static_cast<uint32_t>(IX) | LX) == 0)                 // x == 0
		{
			return (HY < 0) ? (-kPiO2 - kTiny) : (kPiO2 + kTiny);
		}

		if (IX == 0x7FF00000)                                      // x is inf
		{
			if (IY == 0x7FF00000)
			{
				switch (M)
				{
				case 0:  return  kPiO4 + kTiny;
				case 1:  return -kPiO4 - kTiny;
				case 2:  return  3.0 * kPiO4 + kTiny;
				default: return -3.0 * kPiO4 - kTiny;
				}
			}
			switch (M)
			{
			case 0:  return  kZero;
			case 1:  return -kZero;
			case 2:  return  kPi + kTiny;
			default: return -kPi - kTiny;
			}
		}

		if (IY == 0x7FF00000) return (HY < 0) ? (-kPiO2 - kTiny) : (kPiO2 + kTiny);

		K = (IY - IX) >> 20;
		if (K > 60)                    Z = kPiO2 + 0.5 * kPiLo;    // |y/x| > 2^60
		else if (HX < 0 && K < -60)    Z = 0.0;                    // |y|/x < -2^60
		else                           Z = AtanImpl(std::fabs(Y / X));

		switch (M)
		{
		case 0:  return  Z;
		case 1:  return -Z;
		case 2:  return  kPi - (Z - kPiLo);
		default: return (Z - kPiLo) - kPi;
		}
	}
}

namespace ZR
{
	double Sin(double X)
	{
		double Y[2];
		const double Z = 0.0;
		const int32_t IX = HighWord(X) & 0x7FFFFFFF;

		if (IX <= 0x3FE921FB) return KernelSin(X, Z, 0);
		if (IX >= 0x7FF00000) return X - X;

		const int N = RemPio2(X, Y);
		switch (N & 3)
		{
		case 0:  return  KernelSin(Y[0], Y[1], 1);
		case 1:  return  KernelCos(Y[0], Y[1]);
		case 2:  return -KernelSin(Y[0], Y[1], 1);
		default: return -KernelCos(Y[0], Y[1]);
		}
	}

	double Cos(double X)
	{
		double Y[2];
		const double Z = 0.0;
		const int32_t IX = HighWord(X) & 0x7FFFFFFF;

		if (IX <= 0x3FE921FB) return KernelCos(X, Z);
		if (IX >= 0x7FF00000) return X - X;

		const int N = RemPio2(X, Y);
		switch (N & 3)
		{
		case 0:  return  KernelCos(Y[0], Y[1]);
		case 1:  return -KernelSin(Y[0], Y[1], 1);
		case 2:  return -KernelCos(Y[0], Y[1]);
		default: return  KernelSin(Y[0], Y[1], 1);
		}
	}

	double Atan(double X)  { return AtanImpl(X); }

	double Atan2(double Y, double X) { return Atan2Impl(Y, X); }

	int32_t ToInt32(double D)
	{
		if (!std::isfinite(D)) return 0;
		double M = std::fmod(std::trunc(D), 4294967296.0);   // fmod is exact in IEEE-754
		if (M < 0) M += 4294967296.0;
		return static_cast<int32_t>(static_cast<uint32_t>(M));
	}

	double Round(double X)
	{
		return std::floor(X + 0.5);
	}
}
