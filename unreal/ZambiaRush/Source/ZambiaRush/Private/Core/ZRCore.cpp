// ZRCore — see ZRCore.h. Transliterated from js/game3d-core.js.
//
// Keep this file structurally parallel to the JavaScript. When the two
// disagree, the JavaScript is right: it is what shipped, what the server
// validates Ghost Codes against, and what Tools/zrcore_verify.cpp compares to.

#include "ZRCore.h"
#include "ZRMath.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <cctype>
#include <limits>

#if defined(__clang__)
#pragma clang fp contract(off)
#elif defined(__GNUC__)
#pragma GCC optimize("fp-contract=off")
#endif

namespace ZR
{
namespace
{
	// ================= deterministic PRNG + value noise =================

	// hash2 — READ THIS BEFORE CHANGING IT.
	//
	// js/game3d-core.js:28 is:
	//
	//     var h = (ix * 374761393 + iz * 668265263 + seed * 2246822519) | 0;
	//
	// Those are DOUBLE multiplies. Not Math.imul. That matters enormously.
	// With seed = 20260912, seed * 2246822519 is about 4.55e16, which sits in
	// the binade where a double's ULP is 8 — so adding the two smaller terms
	// rounds the low bits away BEFORE `|0` truncates to int32.
	//
	// A port that "correctly" uses exact integer arithmetic here produces
	// completely different values:
	//
	//     hash2(1, 0)   JS double path: -0.459902518
	//                   exact-integer:  +0.946806788
	//     hash2(-5, 2)  JS double path: +0.705333722
	//                   exact-integer:  -0.701339777
	//
	// ...and therefore a completely different mountain. It would look like a
	// perfectly plausible mountain, nothing would crash, and every Ghost Code
	// recorded in the browser would be silently invalid. So: do the arithmetic
	// in double, in JavaScript's left-to-right order, then ToInt32.
	//
	// Note that mulberry32 next door uses Math.imul and IS exact uint32
	// arithmetic. Two adjacent hash functions, opposite rules.
	//
	// The #pragma at the top of this file is also load-bearing: if the
	// compiler contracts `a*b + c*d + e*f` into FMAs it rounds once instead of
	// twice. Three of miombo's four FBM octave seeds (s+7, s+13, s+29) are
	// contraction-sensitive.
	double Hash2(int32_t IX, int32_t IZ, uint32_t Seed)
	{
		const double Sum = static_cast<double>(IX) * 374761393.0
		                 + static_cast<double>(IZ) * 668265263.0
		                 + static_cast<double>(Seed) * 2246822519.0;
		int32_t H = ToInt32(Sum);

		// h = Math.imul(h ^ (h >>> 13), 1274126177) — exact uint32 from here.
		uint32_t HU = static_cast<uint32_t>(H);
		uint32_t X = HU ^ (HU >> 13);
		X = static_cast<uint32_t>(X * 1274126177u);
		return (static_cast<double>(X ^ (X >> 16)) / 4294967296.0) * 2.0 - 1.0;
	}

	inline double Smooth(double T) { return T * T * (3.0 - 2.0 * T); }

	double VNoise(double X, double Z, uint32_t Seed)
	{
		const double FloorX = std::floor(X);
		const double FloorZ = std::floor(Z);
		const int32_t IX = ToInt32(FloorX);
		const int32_t IZ = ToInt32(FloorZ);
		const double FX = X - FloorX;
		const double FZ = Z - FloorZ;
		const double A = Hash2(IX,     IZ,     Seed);
		const double B = Hash2(IX + 1, IZ,     Seed);
		const double C = Hash2(IX,     IZ + 1, Seed);
		const double D = Hash2(IX + 1, IZ + 1, Seed);
		const double U = Smooth(FX);
		const double V = Smooth(FZ);
		return A * (1 - U) * (1 - V) + B * U * (1 - V) + C * (1 - U) * V + D * U * V;
	}

	double SmoothStepN(double V, double A, double B)
	{
		double T = (V - A) / (B - A);
		if (T > 1.0) T = 1.0;
		if (T < 0.0) T = 0.0;
		return T * T * (3.0 - 2.0 * T);
	}

	// ================= track table =================

	FTheme MakeTheme(uint32_t Sky, uint32_t SkyLow, uint32_t Fog, double FogNear, double FogFar,
	                 uint32_t Sun, double SunX, double SunY, double SunZ, uint32_t Ambient,
	                 double Turbidity, double Rayleigh, double MieCoeff, double MieG,
	                 double CloudCover, double Exposure,
	                 uint32_t Grass, uint32_t GrassDry, uint32_t Dirt, uint32_t DirtDark,
	                 uint32_t Rock, uint32_t Trunk, uint32_t Canopy, uint32_t Canopy2,
	                 uint32_t Accent, uint32_t Water)
	{
		FTheme T;
		T.Colour = { Sky, SkyLow, Fog, Sun, Ambient, Grass, GrassDry, Dirt, DirtDark,
		             Rock, Trunk, Canopy, Canopy2, Accent, Water };
		T.FogNear = FogNear; T.FogFar = FogFar;
		T.SunPos[0] = SunX; T.SunPos[1] = SunY; T.SunPos[2] = SunZ;
		T.Turbidity = Turbidity; T.Rayleigh = Rayleigh; T.MieCoeff = MieCoeff; T.MieG = MieG;
		T.CloudCover = CloudCover; T.Exposure = Exposure;
		return T;
	}

	std::vector<FTrackDef> BuildTrackTable()
	{
		std::vector<FTrackDef> Tracks;

		{	// Miombo Meander
			FTrackDef D;
			D.Id = "miombo"; D.Name = "Miombo Meander";
			D.Level = "easy"; D.LevelLabel = "Easy Rider";
			D.Desc = "Flowing forest singletrack";
			D.Seed = 20260912; D.Length = 1250; D.Slope = 0.105; D.Wobble = 0.85; D.KickerEvery = 130;
			D.Hazards.push_back({ EProp::Hippo, 260, 290, 2.6, 1.6, 1.5 });
			D.Theme = MakeTheme(0xBFE8F2, 0xFFF6D9, 0xD8EFDC, 60, 420,
			                    0xFFF7DC, 140, 220, -160, 0x9CC5A8,
			                    4, 1.4, 0.003, 0.78, 0.42, 0.52,
			                    0x4E9B58, 0x7FAE5A, 0x75522E, 0x5A3C1E, 0x8B8570,
			                    0x5A4028, 0x2F7A44, 0x57944B, 0xE8791D, 0x6FBFB4);
			Tracks.push_back(D);
		}
		{	// Baobab Ridge. NOTE: the JS theme object sets `ambient` twice;
			// the later value (0xE0C0A0) is the one that survives.
			FTrackDef D;
			D.Id = "baobab"; D.Name = "Baobab Ridge";
			D.Level = "trail"; D.LevelLabel = "Trail Star";
			D.Desc = "Sunset savanna, big kickers";
			D.Seed = 20261010; D.Length = 1500; D.Slope = 0.13; D.Wobble = 1.0; D.KickerEvery = 110;
			D.Hazards.push_back({ EProp::Elephant, 300, 340, 3.0, 1.6, 1.8 });
			D.Theme = MakeTheme(0xFFC969, 0xF7B733, 0xE09B55, 80, 480,
			                    0xFFE9B0, -200, 70, -280, 0xE0C0A0,
			                    7, 1.7, 0.0035, 0.8, 0.22, 0.46,
			                    0xA8933E, 0xC2A94E, 0x7E4A20, 0x5E3616, 0x8A6A4C,
			                    0x6E4A26, 0x6E5A2A, 0x8A6F33, 0xE8791D, 0xE8A45C);
			Tracks.push_back(D);
		}
		{	// Kasanka Bat Storm — same `ambient` duplication, 0xCCC4D8 wins.
			FTrackDef D;
			D.Id = "kasanka"; D.Name = "Kasanka Bat Storm";
			D.Level = "trail"; D.LevelLabel = "Trail Star";
			D.Desc = "Dusk in the swamp forest - ten million bats overhead";
			D.Seed = 20261121; D.Length = 1400; D.Slope = 0.05; D.Wobble = 0.85; D.KickerEvery = 140;
			D.Hazards.push_back({ EProp::Antelope, 240, 330, 2.2, 1.5, 1.0 });
			D.Theme = MakeTheme(0x4A3E68, 0xF2A05C, 0x9A8A96, 45, 300,
			                    0xFFB877, -170, 38, -250, 0xCCC4D8,
			                    6, 3.2, 0.009, 0.85, 0.25, 0.56,
			                    0x2E6E44, 0x6E8448, 0x6B4E36, 0x4E3826, 0x686458,
			                    0x4A3828, 0x1F5438, 0x2E6E44, 0xE8791D, 0x2E5E56);
			D.Theme.bBats = true; D.Theme.bGroundMist = true;
			Tracks.push_back(D);
		}
		{	// Lower Zambezi
			FTrackDef D;
			D.Id = "zambezi"; D.Name = "Lower Zambezi";
			D.Level = "trail"; D.LevelLabel = "Trail Star";
			D.Desc = "Riverside flow - mind the crocs";
			D.Seed = 20261107; D.Length = 1600; D.Slope = 0.062; D.Wobble = 0.8; D.KickerEvery = 150;
			D.River = { true, 24, 70, 2.2 };
			D.Theme = MakeTheme(0xC2E4EE, 0xF5E6B8, 0xD8E4C4, 70, 450,
			                    0xFFF2CC, -150, 130, -260, 0xB0C49A,
			                    5, 1.7, 0.004, 0.8, 0.3, 0.56,
			                    0x3E8E52, 0x8AA84E, 0x8A6238, 0x6B4826, 0x7E7A64,
			                    0x5A4028, 0x2F7A44, 0x4E9B58, 0xE8791D, 0x2E6E5E);
			Tracks.push_back(D);
		}
		{	// Mosi Falls Drop
			FTrackDef D;
			D.Id = "falls"; D.Name = "Mosi Falls Drop";
			D.Level = "hero"; D.LevelLabel = "Downhill Hero";
			D.Desc = "Steep canyon to the thundering Victoria Falls";
			D.Seed = 20260926; D.Length = 1750; D.Slope = 0.165; D.Wobble = 1.15; D.KickerEvery = 100;
			D.Gorge = { true, 0.84, 32, 95, 60 };
			D.Hazards.push_back({ EProp::Croc,  220, 300, 2.0, 1.7, 1.05 });
			D.Hazards.push_back({ EProp::Rhino, 420, 470, 2.8, 1.5, 1.7 });
			D.Theme = MakeTheme(0xC6ECEF, 0xEAF9F4, 0xA6C4BE, 110, 620,
			                    0xF6FFF0, 180, 260, -60, 0x8FB8A8,
			                    3, 1.0, 0.003, 0.76, 0.5, 0.55,
			                    0x3F8A50, 0x5E9B58, 0x74583A, 0x54402A, 0x6E6A5E,
			                    0x4E3A24, 0x2A6E48, 0x3F8A50, 0x2A9D8F, 0xBFE8E2);
			Tracks.push_back(D);
		}

		return Tracks;
	}

	const std::vector<FTrackDef>& Tracks()
	{
		static const std::vector<FTrackDef> T = BuildTrackTable();
		return T;
	}
}	// anonymous namespace

double FRandom::operator()()
{
	uint32_t A = State;
	A = static_cast<uint32_t>(A + 0x6D2B79F5u);
	State = A;
	uint32_t T = static_cast<uint32_t>((A ^ (A >> 15)) * (1u | A));
	T = static_cast<uint32_t>((T + static_cast<uint32_t>((T ^ (T >> 7)) * (61u | T))) ^ T);
	return static_cast<double>(T ^ (T >> 14)) / 4294967296.0;
}

const char* PropName(EProp Type)
{
	switch (Type)
	{
	case EProp::Miombo:   return "miombo";
	case EProp::Baobab:   return "baobab";
	case EProp::Acacia:   return "acacia";
	case EProp::Palm:     return "palm";
	case EProp::Bush:     return "bush";
	case EProp::Fern:     return "fern";
	case EProp::Grass:    return "grass";
	case EProp::Reed:     return "reed";
	case EProp::Rock:     return "rock";
	case EProp::Termite:  return "termite";
	case EProp::Hippo:    return "hippo";
	case EProp::Elephant: return "elephant";
	case EProp::Croc:     return "croc";
	case EProp::Antelope: return "antelope";
	case EProp::Zebra:    return "zebra";
	case EProp::Giraffe:  return "giraffe";
	case EProp::Rhino:    return "rhino";
	}
	return "rock";
}

const FTrackDef* FindTrack(const std::string& Id)
{
	for (const FTrackDef& D : Tracks())
	{
		if (D.Id == Id) return &D;
	}
	return nullptr;
}

const std::vector<std::string>& TrackOrder()
{
	static const std::vector<std::string> Order =
		{ "miombo", "baobab", "kasanka", "zambezi", "falls" };
	return Order;
}

// ================= world building =================

namespace
{
	double BaseHeight(const FTrackDef& Def, double X, double Z)
	{
		const uint32_t S = Def.Seed;
		double H = -Z * Def.Slope;
		H += 10.0 * VNoise(X / 210.0, Z / 210.0, S);
		H += 5.0  * VNoise(X / 88.0,  Z / 88.0,  S + 7);
		H += 2.1  * VNoise(X / 37.0,  Z / 37.0,  S + 13);
		H += 0.7  * VNoise(X / 13.0,  Z / 13.0,  S + 29);

		// Valley walls keep the ride in a broad corridor; river tracks stay
		// open on the water side so the bank can fall away to the Zambezi.
		double Wall;
		if (Def.River.bValid)      Wall = SmoothStepN(-X, 100, 240) * 30.0;
		else if (Def.Id == "falls") Wall = SmoothStepN(std::fabs(X), 70, 200) * 55.0;
		else                        Wall = SmoothStepN(std::fabs(X), 120, 250) * 34.0;
		return H + Wall;
	}

	struct FTrailPath { std::vector<FTrailPoint> Pts; int32_t N = 0; };

	// The trail spline comes from the track definition alone, so the menu's
	// course map can draw the real line without building a heightfield. `Rng`
	// supplies ONLY the three phase offsets (its first three draws), which
	// keeps BuildWorld's random stream identical to a bare FRandom(seed).
	FTrailPath BuildTrailPath(const FTrackDef& Def, FRandom& Rng)
	{
		FTrailPath Path;
		const int32_t N = static_cast<int32_t>(std::floor(Def.Length / TRAIL_DS));
		Path.N = N;
		Path.Pts.resize(N);

		const double Phi1 = Rng() * 6.28;
		const double Phi2 = Rng() * 6.28;
		const double Phi3 = Rng() * 6.28;

		double X = 0, Z = 0;
		for (int32_t I = 0; I < N; I++)
		{
			const double T = I * TRAIL_DS;
			double Theta = Def.Wobble * (0.62 * Sin(T * 0.011 + Phi1)
			                           + 0.34 * Sin(T * 0.027 + Phi2)
			                           + 0.18 * Sin(T * 0.052 + Phi3));
			if (Theta > 1.0) Theta = 1.0;
			if (Theta < -1.0) Theta = -1.0;
			X += Sin(Theta) * TRAIL_DS;
			Z += Cos(Theta) * TRAIL_DS;
			if (X > X_HALF - 60) X = X_HALF - 60;
			if (X < -(X_HALF - 60)) X = -(X_HALF - 60);
			Path.Pts[I] = { X, Z, 0.0, Theta, T };
		}

		for (int32_t I = 0; I < N; I++)
		{
			Path.Pts[I].Y = BaseHeight(Def, Path.Pts[I].X, Path.Pts[I].Z);
		}
		// Smoothed hard so it is rideable.
		for (int Pass = 0; Pass < 3; Pass++)
		{
			for (int32_t I = 2; I < N - 2; I++)
			{
				Path.Pts[I].Y = (Path.Pts[I - 2].Y + Path.Pts[I - 1].Y * 2 + Path.Pts[I].Y * 3
				               + Path.Pts[I + 1].Y * 2 + Path.Pts[I + 2].Y) / 9.0;
			}
		}
		// Clamp trail grade so climbs stay pedalable.
		for (int32_t I = 1; I < N; I++)
		{
			if (Path.Pts[I].Y > Path.Pts[I - 1].Y + TRAIL_DS * 0.14)
				Path.Pts[I].Y = Path.Pts[I - 1].Y + TRAIL_DS * 0.14;
			if (Path.Pts[I].Y < Path.Pts[I - 1].Y - TRAIL_DS * 0.55)
				Path.Pts[I].Y = Path.Pts[I - 1].Y - TRAIL_DS * 0.55;
		}
		return Path;
	}

	// z is strictly increasing along the trail, so this is a binary search.
	int32_t TrailRangeForZ(const std::vector<FTrailPoint>& Pts, int32_t N, double ZZ)
	{
		int32_t Lo = 0, Hi = N - 1;
		while (Lo < Hi)
		{
			const int32_t Mid = (Lo + Hi) >> 1;
			if (Pts[Mid].Z < ZZ) Lo = Mid + 1; else Hi = Mid;
		}
		return Lo;
	}

	struct FPoolEntry { EProp Type; int Weight; double R; };

	const std::vector<FPoolEntry>& PoolFor(const std::string& Id)
	{
		static const std::vector<FPoolEntry> Miombo = {
			{ EProp::Miombo, 5, 2.0 }, { EProp::Miombo, 5, 2.0 }, { EProp::Bush, 2, 0 },
			{ EProp::Rock, 2, 1.1 }, { EProp::Fern, 1, 0 }, { EProp::Grass, 4, 0 } };
		static const std::vector<FPoolEntry> Baobab = {
			{ EProp::Baobab, 2, 2.6 }, { EProp::Acacia, 3, 1.6 }, { EProp::Termite, 2, 0.9 },
			{ EProp::Grass, 5, 0 }, { EProp::Rock, 2, 1.1 }, { EProp::Bush, 1, 0 } };
		static const std::vector<FPoolEntry> Kasanka = {
			{ EProp::Miombo, 4, 2.0 }, { EProp::Palm, 2, 1.4 }, { EProp::Reed, 3, 0 },
			{ EProp::Fern, 3, 0 }, { EProp::Grass, 2, 0 }, { EProp::Bush, 2, 0 } };
		static const std::vector<FPoolEntry> Zambezi = {
			{ EProp::Palm, 3, 1.4 }, { EProp::Miombo, 3, 2.0 }, { EProp::Reed, 3, 0 },
			{ EProp::Bush, 2, 0 }, { EProp::Grass, 3, 0 }, { EProp::Rock, 1, 1.1 } };
		static const std::vector<FPoolEntry> Falls = {
			{ EProp::Miombo, 4, 2.0 }, { EProp::Palm, 2, 1.4 }, { EProp::Rock, 4, 1.4 },
			{ EProp::Fern, 3, 0 }, { EProp::Grass, 3, 0 }, { EProp::Bush, 1, 0 } };

		if (Id == "baobab")  return Baobab;
		if (Id == "kasanka") return Kasanka;
		if (Id == "zambezi") return Zambezi;
		if (Id == "falls")   return Falls;
		return Miombo;
	}

	const std::vector<EProp>& FaunaFor(const std::string& Id)
	{
		static const std::vector<EProp> Miombo  = { EProp::Antelope, EProp::Antelope, EProp::Zebra };
		static const std::vector<EProp> Baobab  = { EProp::Giraffe, EProp::Elephant, EProp::Zebra,
		                                            EProp::Antelope, EProp::Rhino };
		static const std::vector<EProp> Kasanka = { EProp::Antelope, EProp::Antelope, EProp::Elephant };
		static const std::vector<EProp> Zambezi = { EProp::Elephant, EProp::Antelope, EProp::Zebra };
		static const std::vector<EProp> Falls   = { EProp::Antelope, EProp::Elephant, EProp::Rhino };

		if (Id == "baobab")  return Baobab;
		if (Id == "kasanka") return Kasanka;
		if (Id == "zambezi") return Zambezi;
		if (Id == "falls")   return Falls;
		return Miombo;
	}
}	// anonymous namespace

FTrailPreview TrailPreview(const FTrackDef& Def)
{
	FRandom Rng(Def.Seed);
	const FTrailPath Path = BuildTrailPath(Def, Rng);

	FTrailPreview Out;
	Out.Pts = Path.Pts;
	double MinX = 1e308, MaxX = -1e308;
	for (int32_t I = 0; I < Path.N; I++)
	{
		if (Path.Pts[I].X < MinX) MinX = Path.Pts[I].X;
		if (Path.Pts[I].X > MaxX) MaxX = Path.Pts[I].X;
	}
	Out.MinX = MinX; Out.MaxX = MaxX;
	Out.ZEnd = Path.Pts[Path.N - 1].Z;
	Out.Drop = static_cast<int32_t>(Round(Path.Pts[0].Y - Path.Pts[Path.N - 1].Y));
	Out.Kickers = std::max(1, static_cast<int32_t>(Round(Def.Length / Def.KickerEvery)));
	return Out;
}

double HeightAt(const FWorld& W, double X, double Z)
{
	double FX = (X - W.X0) / W.Step;
	double FZ = (Z - W.Z0) / W.Step;
	int32_t IX = static_cast<int32_t>(std::floor(FX));
	int32_t IZ = static_cast<int32_t>(std::floor(FZ));
	if (IX < 0) IX = 0;
	if (IZ < 0) IZ = 0;
	if (IX > W.NX - 2) IX = W.NX - 2;
	if (IZ > W.NZ - 2) IZ = W.NZ - 2;
	const double TX = FX - IX;
	const double TZ = FZ - IZ;
	const int32_t I00 = IZ * W.NX + IX;
	const double A = W.H[I00],           B = W.H[I00 + 1];
	const double C = W.H[I00 + W.NX],    D = W.H[I00 + W.NX + 1];
	return A * (1 - TX) * (1 - TZ) + B * TX * (1 - TZ) + C * (1 - TX) * TZ + D * TX * TZ;
}

double TrailDistAt(const FWorld& W, double X, double Z)
{
	const double FX = (X - W.X0) / W.Step;
	const double FZ = (Z - W.Z0) / W.Step;
	int32_t IX = static_cast<int32_t>(Round(FX));
	int32_t IZ = static_cast<int32_t>(Round(FZ));
	if (IX < 0) IX = 0;
	if (IZ < 0) IZ = 0;
	if (IX > W.NX - 1) IX = W.NX - 1;
	if (IZ > W.NZ - 1) IZ = W.NZ - 1;
	return W.TD[IZ * W.NX + IX];
}

FNormal NormalAt(const FWorld& W, double X, double Z)
{
	const double E = 1.2;
	const double HX = HeightAt(W, X + E, Z) - HeightAt(W, X - E, Z);
	const double HZ = HeightAt(W, X, Z + E) - HeightAt(W, X, Z - E);
	const double NX = -HX / (2 * E);
	const double NZ = -HZ / (2 * E);
	const double Len = std::sqrt(NX * NX + 1 + NZ * NZ);
	return { NX / Len, 1.0 / Len, NZ / Len };
}

FWorld BuildWorld(const FTrackDef& Def)
{
	// Every draw from this generator must happen in exactly the order the
	// JavaScript draws them, or the world diverges. Where a draw sits inside
	// a conditional in the original, it sits inside the same conditional here.
	FRandom Rng(Def.Seed);

	FTrailPath Path = BuildTrailPath(Def, Rng);
	std::vector<FTrailPoint>& Pts = Path.Pts;
	const int32_t N = Path.N;
	const double ZEnd = Pts[N - 1].Z;

	// ---- kickers: shaped bumps that launch you ----
	std::vector<int32_t> Kickers;
	{
		double KZ = 25 + Rng() * Def.KickerEvery;
		while (KZ < Def.Length - 120)
		{
			const int32_t KI = static_cast<int32_t>(std::floor(KZ / TRAIL_DS));
			if (KI > 4 && KI < N - 6)
			{
				Kickers.push_back(KI);
				const double Amp = 0.9 + Rng() * 0.7;
				Pts[KI - 1].Y += Amp * 0.35;
				Pts[KI].Y += Amp;          // lip; the drop after it is the jump
			}
			KZ += Def.KickerEvery * (0.75 + Rng() * 0.6);
		}
	}

	// ---- heightfield grid with the trail carved in ----
	const int32_t NX = static_cast<int32_t>(std::floor((X_HALF * 2) / GRID_STEP)) + 1;
	const double Z0 = -40.0;
	const double Z1 = ZEnd + 100.0;
	const int32_t NZ = static_cast<int32_t>(std::floor((Z1 - Z0) / GRID_STEP)) + 1;

	FWorld W;
	W.Def = &Def;
	W.NX = NX; W.NZ = NZ; W.Z0 = Z0; W.X0 = -X_HALF; W.Step = GRID_STEP;
	W.H.assign(static_cast<size_t>(NX) * NZ, 0.0f);
	W.TD.assign(static_cast<size_t>(NX) * NZ, 0.0f);

	for (int32_t GZ = 0; GZ < NZ; GZ++)
	{
		const double WZ = Z0 + GZ * GRID_STEP;
		const int32_t CI = TrailRangeForZ(Pts, N, WZ);
		for (int32_t GX = 0; GX < NX; GX++)
		{
			const double WX = -X_HALF + GX * GRID_STEP;
			const double H = BaseHeight(Def, WX, WZ);
			double Best = 1e9, BestY = 0;
			for (int32_t K = std::max(0, CI - 8); K < std::min(N, CI + 8); K++)
			{
				const double DX = Pts[K].X - WX, DZ = Pts[K].Z - WZ;
				const double D2 = DX * DX + DZ * DZ;
				if (D2 < Best) { Best = D2; BestY = Pts[K].Y; }
			}
			const double D = std::sqrt(Best);
			const double Wt = 1.0 - SmoothStepN(D, 2.2, CARVE_R);
			W.H[static_cast<size_t>(GZ) * NX + GX]  = static_cast<float>(H * (1 - Wt) + BestY * Wt);
			W.TD[static_cast<size_t>(GZ) * NX + GX] = static_cast<float>(D);
		}
	}

	// ---- river tracks: drop everything past the bank to the water ----
	if (Def.River.bValid)
	{
		W.bHasRiver = true;
		W.RowWaterY.assign(NZ, 0.0f);
		W.RowEdgeX.assign(NZ, 0.0f);
		for (int32_t GZ = 0; GZ < NZ; GZ++)
		{
			const double WZ2 = Z0 + GZ * GRID_STEP;
			const int32_t TI2 = TrailRangeForZ(Pts, N, WZ2);
			const FTrailPoint& TP = Pts[std::min(N - 1, TI2)];
			const double Edge = TP.X + Def.River.Offset;
			const double WY = TP.Y - Def.River.Depth;
			W.RowWaterY[GZ] = static_cast<float>(WY);
			W.RowEdgeX[GZ]  = static_cast<float>(Edge);
			for (int32_t GX = 0; GX < NX; GX++)
			{
				const double WX2 = -X_HALF + GX * GRID_STEP;
				const double DEdge = WX2 - Edge;
				const size_t VI2 = static_cast<size_t>(GZ) * NX + GX;
				if (DEdge <= -30)
				{
					// The floodplain never dips under the waterline - the only
					// place to get wet is the river itself.
					if (W.H[VI2] < WY + 1.3) W.H[VI2] = static_cast<float>(WY + 1.3);
				}
				else if (DEdge < 12)
				{
					const double K = SmoothStepN(DEdge, -30, 12);
					const double HLand = W.H[VI2] < WY + 1.3 ? WY + 1.3 : static_cast<double>(W.H[VI2]);
					W.H[VI2] = static_cast<float>(HLand * (1 - K) + (WY - 1.2) * K);
				}
				else if (DEdge < Def.River.Width)
				{
					W.H[VI2] = static_cast<float>(WY - 1.2 - std::min(2.2, (DEdge - 12) * 0.1));
				}
				else
				{
					W.H[VI2] = static_cast<float>(WY - 1
						+ SmoothStepN(DEdge, Def.River.Width, Def.River.Width + 36) * 9.0);
				}
			}
		}
	}

	// ---- Victoria Falls finale: a transverse chasm beside the rim trail ----
	if (Def.Gorge.bValid)
	{
		W.bHasGorge = true;
		const FGorgeDef& G = Def.Gorge;
		W.RowGorgeX.assign(NZ, std::numeric_limits<float>::infinity());
		for (int32_t GZ = 0; GZ < NZ; GZ++)
		{
			const double GWZ = Z0 + GZ * GRID_STEP;
			const int32_t GTI = std::min(N - 1, TrailRangeForZ(Pts, N, GWZ));
			const double GFrac = static_cast<double>(GTI) / (N - 1);
			const double Fade = SmoothStepN(GFrac, G.FromFrac - 0.05, G.FromFrac + 0.02);
			if (Fade <= 0) continue;
			const FTrailPoint& GTP = Pts[GTI];
			const double EdgeG = GTP.X + G.Offset;
			const double FloorY = GTP.Y - G.Depth;
			const double LipY = GTP.Y + 5;
			if (Fade > 0.4) W.RowGorgeX[GZ] = static_cast<float>(EdgeG);
			for (int32_t GX = 0; GX < NX; GX++)
			{
				const double GWX = -X_HALF + GX * GRID_STEP;
				const double DG = GWX - EdgeG;
				if (DG <= 0) continue;
				const size_t GVI = static_cast<size_t>(GZ) * NX + GX;
				double Carved;
				if (DG < 7)                 Carved = W.H[GVI] + SmoothStepN(DG, 0, 7) * (FloorY - W.H[GVI]);
				else if (DG < G.Width - 10) Carved = FloorY;
				else if (DG < G.Width)      Carved = FloorY + SmoothStepN(DG, G.Width - 10, G.Width) * (LipY - FloorY);
				else if (DG < G.Width + 70) Carved = LipY + (DG - G.Width) * 0.03;   // upper river plateau
				else                        Carved = LipY + 2.1
					+ SmoothStepN(DG, G.Width + 70, G.Width + 120) * (W.H[GVI] - LipY - 2.1);
				W.H[GVI] = static_cast<float>(W.H[GVI] * (1 - Fade) + Carved * Fade);
			}
		}
	}

	W.Trail = Pts;
	W.TrailN = N;
	W.FinishIdx = N - 4;
	W.Kickers = Kickers;

	// Re-sample trail y from the carved grid so physics and path agree.
	for (int32_t I = 0; I < N; I++)
	{
		W.Trail[I].Y = HeightAt(W, W.Trail[I].X, W.Trail[I].Z);
	}

	if (Def.River.bValid)
	{
		W.RiverEdgeX.assign(N, 0.0f);
		W.WaterY.assign(N, 0.0f);
		for (int32_t I = 0; I < N; I++)
		{
			W.RiverEdgeX[I] = static_cast<float>(W.Trail[I].X + Def.River.Offset);
			W.WaterY[I]     = static_cast<float>(W.Trail[I].Y - Def.River.Depth);
		}
	}

	// ---- gates (checkpoints) every ~150 m + finish ----
	{
		const int32_t StepI = static_cast<int32_t>(Round(150.0 / TRAIL_DS));
		for (int32_t I = 30; I < N - 8; I += StepI) W.Gates.push_back(I);
	}

	// ---- coins along the trail, arcing over kickers ----
	{
		double CZ = 40;
		while (CZ < Def.Length - 60)
		{
			const int32_t CIX = static_cast<int32_t>(std::floor(CZ / TRAIL_DS));
			if (CIX >= N - 6) break;
			bool bOverKick = false;
			for (size_t K = 0; K < Kickers.size(); K++)
			{
				if (std::abs(Kickers[K] - CIX) < 4) { bOverKick = true; break; }
			}
			const int Count = 4;
			for (int K = 0; K < Count; K++)
			{
				const FTrailPoint& P = W.Trail[std::min(N - 1, CIX + K)];
				const double Lift = bOverKick
					? 1.4 + 1.5 * Sin((static_cast<double>(K) / (Count - 1)) * 3.141592653589793)
					: 1.2;
				W.Coins.push_back({ P.X, P.Y + Lift, P.Z });
			}
			CZ += 30 + Rng() * 36;
		}
	}

	// ---- props: trees, rocks, wildlife - never on the trail ----
	{
		std::vector<std::pair<EProp, double>> Pool;
		for (const FPoolEntry& E : PoolFor(Def.Id))
		{
			for (int Q = 0; Q < E.Weight; Q++) Pool.push_back({ E.Type, E.R });
		}

		const int32_t PropCount = static_cast<int32_t>(std::floor(Def.Length * 1.35));
		for (int32_t I = 0; I < PropCount; I++)
		{
			const double PX = (Rng() * 2 - 1) * (X_HALF - 12);
			const double PZ = Rng() * (ZEnd - 20) + 5;
			const int32_t TI = TrailRangeForZ(W.Trail, N, PZ);
			double DBest = 1e9;
			for (int32_t K = std::max(0, TI - 6); K < std::min(N, TI + 6); K++)
			{
				const double DDX = W.Trail[K].X - PX, DDZ = W.Trail[K].Z - PZ;
				const double DD = DDX * DDX + DDZ * DDZ;
				if (DD < DBest) DBest = DD;
			}
			DBest = std::sqrt(DBest);

			// This draw happens whether or not the prop is accepted. Moving it
			// below the rejection tests would desync the whole stream.
			const std::pair<EProp, double>& Pick = Pool[static_cast<size_t>(std::floor(Rng() * Pool.size()))];
			const double Margin = Pick.second > 0 ? 7.5 : 4.5;
			if (DBest < Margin) continue;

			if (Def.River.bValid)
			{
				const int32_t RTI = TrailRangeForZ(W.Trail, N, PZ);
				if (PX > W.Trail[std::min(N - 1, RTI)].X + Def.River.Offset - 5) continue;
			}
			if (Def.Gorge.bValid)
			{
				const int32_t GPI = std::min(N - 1, TrailRangeForZ(W.Trail, N, PZ));
				if (static_cast<double>(GPI) / (N - 1) > Def.Gorge.FromFrac - 0.06 &&
				    PX > W.Trail[GPI].X + Def.Gorge.Offset - 6) continue;
			}
			W.Props.push_back({ Pick.first, PX, PZ, HeightAt(W, PX, PZ),
			                    0.75 + Rng() * 0.7, Rng() * 6.28, Pick.second });
		}
	}

	// ---- Lower Zambezi hazards & riverside life ----
	if (Def.River.bValid)
	{
		// Crocs sun themselves ON the trail edges - the racing line stays open,
		// but a lazy line meets teeth. Straight-ish segments only, so the AI
		// ghosts' centre line never clips one.
		double CZ2 = 140;
		double Side2 = 1;
		while (CZ2 < Def.Length - 120)
		{
			const int32_t CIT = static_cast<int32_t>(std::floor(CZ2 / TRAIL_DS));
			if (CIT > 6 && CIT < N - 8)
			{
				const double YawA = Atan2(W.Trail[CIT + 3].X - W.Trail[CIT - 3].X,
				                          W.Trail[CIT + 3].Z - W.Trail[CIT - 3].Z);
				const double YawB = W.Trail[CIT].Yaw;
				if (std::fabs(YawA - YawB) < 0.14)
				{
					const FTrailPoint& CP = W.Trail[CIT];
					const double Lat = Side2 * (2.05 + Rng() * 1.9);
					W.Props.push_back({ EProp::Croc, CP.X + Lat, CP.Z,
					                    HeightAt(W, CP.X + Lat, CP.Z),
					                    0.85 + Rng() * 0.4, Rng() * 6.28, 1.05 });
					Side2 = -Side2;
				}
			}
			CZ2 += 120 + Rng() * 90;
		}
		// A few more crocs hauled out on the beach, plus hippo pods in the water.
		double BZ = 200;
		while (BZ < Def.Length - 150)
		{
			const int32_t BTI = static_cast<int32_t>(std::floor(BZ / TRAIL_DS));
			const FTrailPoint& BP = W.Trail[std::min(N - 1, BTI)];
			if (Rng() < 0.6)
			{
				W.Props.push_back({ EProp::Croc,
					BP.X + Def.River.Offset - 5 - Rng() * 5, BP.Z,
					HeightAt(W, BP.X + Def.River.Offset - 5, BP.Z),
					0.9 + Rng() * 0.45, 1.2 + Rng() * 0.8, 1.05 });
			}
			else
			{
				const double HX = BP.X + Def.River.Offset + 16 + Rng() * 24;
				W.Props.push_back({ EProp::Hippo, HX, BP.Z,
					(!W.WaterY.empty() ? BP.Y - Def.River.Depth : BP.Y) + 0.1,
					1.0, Rng() * 6.28, 0.0 });
			}
			BZ += 240 + Rng() * 200;
		}
	}

	// ---- wildlife, well away from the trail ----
	{
		const std::vector<EProp>& Fauna = FaunaFor(Def.Id);
		double FZ = 150;
		while (FZ < ZEnd - 150)
		{
			const double Side = Rng() < 0.5 ? -1.0 : 1.0;
			const int32_t TI2 = TrailRangeForZ(W.Trail, N, FZ);
			const double FX = W.Trail[std::min(N - 1, TI2)].X + Side * (26 + Rng() * 40);
			if (std::fabs(FX) < X_HALF - 20)
			{
				const EProp FT = Fauna[static_cast<size_t>(std::floor(Rng() * Fauna.size()))];
				W.Props.push_back({ FT, FX, FZ, HeightAt(W, FX, FZ), 1.0, Rng() * 6.28, 2.2 });
			}
			FZ += 260 + Rng() * 240;
		}
	}

	// ---- trail hazards: big animals dozing on the racing line's edges ----
	// Straight-ish segments only, alternating sides, never on the centre line -
	// the AI ghosts stay clean and a good line always exists, but a lazy line
	// meets two tonnes of hippo. Placed last so the draws above stay untouched.
	for (const FHazardDef& HZ : Def.Hazards)
	{
		double HZZ = HZ.From;
		double HZSide = 1;
		while (HZZ < Def.Length - 120)
		{
			const int32_t HZI = static_cast<int32_t>(std::floor(HZZ / TRAIL_DS));
			if (HZI > 6 && HZI < N - 8)
			{
				const double HYawA = Atan2(W.Trail[HZI + 3].X - W.Trail[HZI - 3].X,
				                           W.Trail[HZI + 3].Z - W.Trail[HZI - 3].Z);
				if (std::fabs(HYawA - W.Trail[HZI].Yaw) < 0.14)
				{
					const FTrailPoint& HZP = W.Trail[HZI];
					const double HZLat = HZSide * (HZ.Lat + Rng() * HZ.Spread);
					W.Props.push_back({ HZ.Type, HZP.X + HZLat, HZP.Z,
					                    HeightAt(W, HZP.X + HZLat, HZP.Z),
					                    0.9 + Rng() * 0.25, Rng() * 6.28, HZ.R });
					HZSide = -HZSide;
				}
			}
			HZZ += HZ.Every + Rng() * 110;
		}
	}

	// ---- spatial hash of solid props for collisions ----
	for (size_t I = 0; I < W.Props.size(); I++)
	{
		const FProp& PR = W.Props[I];
		if (PR.R <= 0) continue;
		const int32_t CX = static_cast<int32_t>(std::floor(PR.X / W.HashCell));
		const int32_t CZ = static_cast<int32_t>(std::floor(PR.Z / W.HashCell));
		const int64_t Key = (static_cast<int64_t>(CX) << 32) | static_cast<uint32_t>(CZ);
		W.Hash[Key].push_back(static_cast<int32_t>(I));
	}

	return W;
}

// ================= physics =================

namespace
{
	constexpr double TAU = 6.283185307179586;
	constexpr double PI_D = 3.141592653589793;

	inline double Dist2Trail(const FTrailPoint& P, const FRiderState& St)
	{
		const double DX = P.X - St.X, DZ = P.Z - St.Z;
		return DX * DX + DZ * DZ;
	}

	inline double AngleWrap(double A)
	{
		while (A > PI_D) A -= 2 * PI_D;
		while (A < -PI_D) A += 2 * PI_D;
		return A;
	}

	inline FEvent MakeEv(EEvent T) { FEvent E; E.Type = T; return E; }
}

FRiderState NewRider(const FWorld& W)
{
	const FTrailPoint& P0 = W.Trail[2];
	const FTrailPoint& P1 = W.Trail[3];
	FRiderState St;
	St.X = P0.X; St.Y = P0.Y; St.Z = P0.Z;
	St.Yaw = Atan2(P1.X - P0.X, P1.Z - P0.Z);
	return St;
}

void StepRider(FRiderState& St, const FInput& In, const FWorld& W,
               std::vector<FEvent>& Ev, std::vector<uint8_t>& Taken)
{
	const FBikeStats& S = St.Stats;
	double Speed;

	St.HopCd -= DT;

	// --- turbo window: one press opens it, every tap after that feeds the
	//     throttle, and the throttle bleeds away if the tapping slows down ---
	if (St.TurboCd > 0)
	{
		St.TurboCd -= DT;
		if (St.TurboCd < 0) St.TurboCd = 0;
	}
	if (In.bTurbo)
	{
		if (St.TurboT <= 0 && St.TurboCd <= 0 && St.CrashT <= 0)
		{
			St.TurboT = TURBO_WINDOW * S.TurboWindow;
			St.Throttle = 0;
			St.TurboTaps = 0;
			St.TurboUses++;
			Ev.push_back(MakeEv(EEvent::TurboOn));
		}
		else if (St.TurboT > 0)
		{
			St.Throttle += TURBO_TAP * S.TurboTap;
			if (St.Throttle > 1) St.Throttle = 1;
			St.TurboTaps++;
		}
	}
	if (St.TurboT > 0)
	{
		St.TurboT -= DT;
		// Decay proportional to the current throttle, so a steady tapping rate
		// settles at a steady level: taps/sec * TURBO_TAP / TURBO_DECAY.
		St.Throttle -= TURBO_DECAY * St.Throttle * DT;
		if (St.Throttle < 0.004) St.Throttle = 0;
		if (St.TurboT <= 0)
		{
			St.TurboT = 0;
			St.Throttle = 0;
			St.TurboCd = TURBO_COOLDOWN * S.TurboCool;
			Ev.push_back(MakeEv(EEvent::TurboOff));
		}
	}

	// --- crash state: tumble briefly, then respawn at the last gate ---
	if (St.CrashT > 0)
	{
		St.CrashT -= DT;
		St.VX *= 0.9; St.VZ *= 0.9;
		if (!St.bOnGround) { St.VY -= GRAV * DT; St.Y += St.VY * DT; }
		St.X += St.VX * DT; St.Z += St.VZ * DT;
		const double GH = HeightAt(W, St.X, St.Z);
		if (St.Y <= GH) { St.Y = GH; St.bOnGround = true; St.VY = 0; }
		if (St.CrashT <= 0)
		{
			const FTrailPoint& RP = W.Trail[St.RespawnIdx];
			const FTrailPoint& RQ = W.Trail[std::min(W.TrailN - 1, St.RespawnIdx + 1)];
			St.X = RP.X; St.Z = RP.Z; St.Y = RP.Y;
			St.Yaw = Atan2(RQ.X - RP.X, RQ.Z - RP.Z);
			St.VX = St.VY = St.VZ = 0;
			St.bOnGround = true;
			St.TrailIdx = St.RespawnIdx;
			Ev.push_back(MakeEv(EEvent::Respawn));
		}
		St.T += DT;
		return;
	}

	// The rider faces +z and the chase camera sits behind, so screen-right is
	// world -x: "right" must turn the heading toward -x, i.e. lower yaw.
	const double Steer = (In.bLeft ? 1.0 : 0.0) - (In.bRight ? 1.0 : 0.0);

	if (St.bOnGround)
	{
		const FNormal Nrm = NormalAt(W, St.X, St.Z);
		// Forward, projected onto the slope.
		const double FX0 = Sin(St.Yaw), FZ0 = Cos(St.Yaw);
		const double Dot = FX0 * Nrm.X + FZ0 * Nrm.Z;      // f.n with f.y = 0
		double FfX = FX0 - Nrm.X * Dot;
		double FfY = -Dot * Nrm.Y;
		double FfZ = FZ0 - Nrm.Z * Dot;
		double FL = std::sqrt(FfX * FfX + FfY * FfY + FfZ * FfZ);
		if (FL == 0.0) FL = 1.0;
		FfX /= FL; FfY /= FL; FfZ /= FL;

		Speed = St.VX * FfX + St.VY * FfY + St.VZ * FfZ;

		// Forces along the trail direction.
		Speed += (-GRAV * FfY) * DT;                       // slope: f.y < 0 going down

		// Turbo raises the ceiling and pushes on its own, which is what makes
		// it felt on a descent where pedalling alone is already capped out.
		const double Boost = St.TurboT > 0 ? St.Throttle * S.TurboPow : 0.0;
		const double VLim = VCAP * S.VCap * (1 + Boost * TURBO_VCAP);
		if (In.bPedal && Speed < VLim)
		{
			Speed += PEDAL_A * S.Pedal * (Speed < 6 ? 1.55 : 1.0) * St.Power
			       * (1 + Boost * TURBO_PEDAL) * DT;
		}
		if (Boost > 0 && Speed < VLim) Speed += TURBO_THRUST * Boost * DT;
		if (In.bBrake) { Speed -= BRAKE_A * S.Brake * DT; if (Speed < 0) Speed = 0; }

		const bool bOffT = St.TrailD > CARVE_R;
		St.bOffTrail = bOffT;
		const double Drag = DRAG * (bOffT ? 1 + 1.4 * S.Rough : 1.0);
		Speed -= Speed * std::fabs(Speed) * Drag * DT;
		Speed -= Sign(Speed) * std::min(std::fabs(Speed),
			ROLL * S.Roll * (bOffT ? 1 + 1.2 * S.Rough : 1.0) * DT * 10.0);

		// Steering, softer at speed.
		St.Yaw += Steer * STEER_RATE * S.Steer / (1 + std::fabs(Speed) / 16.0) * DT
		        * (Speed >= 0 ? 1.0 : -1.0);
		St.Lean += ((-Steer * std::min(1.0, std::fabs(Speed) / 12.0) * 0.45) - St.Lean)
		         * std::min(1.0, 8 * DT);

		St.VX = FfX * Speed; St.VY = FfY * Speed; St.VZ = FfZ * Speed;

		// Hop.
		if (In.bHop && St.HopCd <= 0)
		{
			St.VY += HOP_V * S.Hop;
			St.HopCd = 0.55;
			St.bOnGround = false;
			St.AirT = 0;
			Ev.push_back(MakeEv(EEvent::Hop));
		}

		St.X += St.VX * DT; St.Z += St.VZ * DT;
		const double HNew = HeightAt(W, St.X, St.Z);
		const double YBallistic = St.Y + St.VY * DT;
		if (!St.bOnGround)
		{
			St.Y = YBallistic;                             // just hopped
		}
		else if (HNew < YBallistic - 0.32)
		{
			St.bOnGround = false; St.AirT = 0;             // crest launch
			St.Pitch = 0; St.PitchV = 0; St.Spin = 0; St.SpinV = 0;
			St.Y = YBallistic;
			Ev.push_back(MakeEv(EEvent::TakeOff));
		}
		else
		{
			St.Y = HNew;
		}
		St.WheelSpin += Speed * DT / 0.34;
	}
	else
	{
		// --- airborne ---
		St.AirT += DT;
		St.VY -= GRAV * DT;
		St.Yaw += Steer * 1.0 * DT;

		// Tricks are pure showmanship: flips and spins wind up their own
		// rotations and never touch velocity or heading, so where you land is
		// unchanged - and the AI, which never sets these inputs, is untouched.
		if (In.bFlipF) St.PitchV += FLIP_ACC * DT;
		if (In.bFlipB) St.PitchV -= FLIP_ACC * DT;
		if (St.PitchV > FLIP_MAX) St.PitchV = FLIP_MAX;
		if (St.PitchV < -FLIP_MAX) St.PitchV = -FLIP_MAX;
		St.Pitch += St.PitchV * DT;
		if (In.bSpinR) St.SpinV += SPIN_ACC * DT;
		if (In.bSpinL) St.SpinV -= SPIN_ACC * DT;
		if (St.SpinV > SPIN_MAX) St.SpinV = SPIN_MAX;
		if (St.SpinV < -SPIN_MAX) St.SpinV = -SPIN_MAX;
		St.Spin += St.SpinV * DT;

		// Let go and the rider tucks back to level - that release is the skill:
		// hold long enough to come round, let go in time to land it.
		if (!In.bFlipF && !In.bFlipB)
		{
			St.PitchV *= std::max(0.0, 1 - 4 * DT);
			St.Pitch += (Round(St.Pitch / TAU) * TAU - St.Pitch) * std::min(1.0, 3.2 * DT);
		}
		if (!In.bSpinL && !In.bSpinR)
		{
			St.SpinV *= std::max(0.0, 1 - 4 * DT);
			St.Spin += (Round(St.Spin / TAU) * TAU - St.Spin) * std::min(1.0, 3.2 * DT);
		}
		St.Lean += ((-Steer * 0.35) - St.Lean) * std::min(1.0, 5 * DT);
		St.X += St.VX * DT; St.Y += St.VY * DT; St.Z += St.VZ * DT;

		const double HG = HeightAt(W, St.X, St.Z);
		if (St.Y <= HG)
		{
			St.Y = HG;
			const FNormal NL = NormalAt(W, St.X, St.Z);
			const double Impact = -(St.VX * NL.X + St.VY * NL.Y + St.VZ * NL.Z);
			const bool bWasBig = St.AirT > 0.9;
			// How far from level the bike is, after taking off whole rotations.
			const double Resid = St.Pitch - Round(St.Pitch / TAU) * TAU;
			const bool bSpun = std::fabs(St.Pitch) > 0.6;
			const bool bSketchy = bSpun && std::fabs(Resid) > TRICK_SLOP;
			const bool bUntidy  = bSpun && std::fabs(Resid) > TRICK_ROUGH;

			if ((Impact > CRASH_IMPACT * (1 + S.LandSoft) || bSketchy) && !St.bNoCrash)
			{
				St.CrashT = 1.0;
				St.Crashes++;
				FEvent E = MakeEv(EEvent::Crash);
				E.Cause = bSketchy ? FEvent::ECause::TrickLanding : FEvent::ECause::Landing;
				Ev.push_back(E);
				St.Pitch = 0; St.PitchV = 0; St.Spin = 0; St.SpinV = 0;
			}
			else
			{
				// Keep the tangent component of velocity.
				const double VN = St.VX * NL.X + St.VY * NL.Y + St.VZ * NL.Z;
				St.VX -= NL.X * VN; St.VY -= NL.Y * VN; St.VZ -= NL.Z * VN;
				if (Impact > 8.5 * (1 + 0.5 * S.LandSoft) || bUntidy)
				{
					const double Keep = bUntidy ? 0.6 : 0.75 + 0.2 * S.LandSoft;
					St.VX *= Keep; St.VY *= Keep; St.VZ *= Keep;
					FEvent E = MakeEv(EEvent::Land); E.bHard = true;
					Ev.push_back(E);
				}
				else
				{
					FEvent E = MakeEv(EEvent::Land); E.bHard = false;
					Ev.push_back(E);
				}
				if (bWasBig) { St.BigAirs++; St.Score += 75; Ev.push_back(MakeEv(EEvent::BigAir)); }

				// Landed it: bank whatever was completed in the air.
				const int32_t Flips = bUntidy ? 0
					: static_cast<int32_t>(std::floor(std::fabs(St.Pitch) / TAU + 0.02));
				const int32_t Spins = static_cast<int32_t>(std::floor(std::fabs(St.Spin) / TAU + 0.02));
				if (Flips || Spins)
				{
					int32_t Pts = Flips * TRICK_FLIP_PTS + Spins * TRICK_SPIN_PTS;
					if (Flips && Spins) Pts = static_cast<int32_t>(Round(Pts * 1.5));   // combo
					St.Score += Pts;
					St.Tricks += Flips + Spins;
					St.TrickPts += Pts;
					FEvent E = MakeEv(EEvent::Trick);
					E.Flips = Flips; E.Spins = Spins; E.Pts = Pts;
					E.bBack = St.Pitch < 0; E.bCombo = (Flips && Spins);
					Ev.push_back(E);
				}
				St.Pitch = 0; St.PitchV = 0; St.Spin = 0; St.SpinV = 0;
			}
			St.bOnGround = true;
		}
	}

	// --- solid props: trees hurt at speed ---
	Speed = std::sqrt(St.VX * St.VX + St.VZ * St.VZ);
	if (St.CrashT <= 0 && Speed > 0.5)
	{
		const int32_t CellX = static_cast<int32_t>(std::floor(St.X / W.HashCell));
		const int32_t CellZ = static_cast<int32_t>(std::floor(St.Z / W.HashCell));
		for (int32_t CX = CellX - 1; CX <= CellX + 1 && St.CrashT <= 0; CX++)
		{
			for (int32_t CZ = CellZ - 1; CZ <= CellZ + 1 && St.CrashT <= 0; CZ++)
			{
				const int64_t Key = (static_cast<int64_t>(CX) << 32) | static_cast<uint32_t>(CZ);
				auto It = W.Hash.find(Key);
				if (It == W.Hash.end()) continue;
				const std::vector<int32_t>& Bucket = It->second;
				for (size_t I = 0; I < Bucket.size(); I++)
				{
					const FProp& PR = W.Props[Bucket[I]];
					const double DX = PR.X - St.X, DZ = PR.Z - St.Z;
					const double Rr = PR.R * 0.55 + 0.4;
					if (DX * DX + DZ * DZ < Rr * Rr && St.Y < PR.Y + 3)
					{
						if (Speed > 6 && !St.bNoCrash)
						{
							St.CrashT = 1.0; St.Crashes++;
							FEvent E = MakeEv(EEvent::Crash);
							E.Cause = FEvent::ECause::Prop; E.PropCause = PR.Type;
							Ev.push_back(E);
						}
						else
						{
							// Low-speed bump: push out and stop.
							double DL = std::sqrt(DX * DX + DZ * DZ);
							if (DL == 0.0) DL = 1.0;
							St.X -= (DX / DL) * 0.3; St.Z -= (DZ / DL) * 0.3;
							St.VX *= 0.2; St.VZ *= 0.2;
						}
						break;
					}
				}
			}
		}
	}

	// --- trail progress (greedy forward search) ---
	{
		const std::vector<FTrailPoint>& Tr = W.Trail;
		int32_t Best = St.TrailIdx;
		double BestD = Dist2Trail(Tr[Best], St);
		for (int32_t I = St.TrailIdx + 1; I < std::min(W.TrailN, St.TrailIdx + 10); I++)
		{
			const double D2 = Dist2Trail(Tr[I], St);
			if (D2 < BestD) { BestD = D2; Best = I; }
		}
		St.TrailIdx = Best;
		St.TrailD = std::sqrt(BestD);
		for (int32_t I = static_cast<int32_t>(W.Gates.size()) - 1; I >= 0; I--)
		{
			if (W.Gates[I] <= St.TrailIdx)
			{
				if (W.Gates[I] > St.RespawnIdx)
				{
					St.RespawnIdx = W.Gates[I];
					Ev.push_back(MakeEv(EEvent::Gate));
				}
				break;
			}
		}
	}

	// --- coins ---
	{
		const std::vector<FCoin>& Coins = W.Coins;
		const int32_t NC = static_cast<int32_t>(Coins.size());
		while (St.CoinPtr < NC && Coins[St.CoinPtr].Z < St.Z - 12) St.CoinPtr++;
		for (int32_t I = St.CoinPtr; I < NC && I < St.CoinPtr + 14; I++)
		{
			if (Taken[I]) continue;
			const FCoin& Co = Coins[I];
			const double DDX = Co.X - St.X;
			const double DDY = Co.Y - (St.Y + 0.9);
			const double DDZ = Co.Z - St.Z;
			if (DDX * DDX + DDY * DDY + DDZ * DDZ < 2.2 * 2.2)
			{
				Taken[I] = 1;
				St.CoinCount++; St.Score += 25;
				Ev.push_back(MakeEv(EEvent::Coin));
			}
		}
	}

	// --- ride into the river: below the water line means swimming ---
	if (!W.RowWaterY.empty() && St.CrashT <= 0)
	{
		const int32_t GZI = std::max(0, std::min(W.NZ - 1,
			static_cast<int32_t>(Round((St.Z - W.Z0) / W.Step))));
		if (St.Y < W.RowWaterY[GZI] - 0.12)
		{
			St.CrashT = 0.7;
			Ev.push_back(MakeEv(EEvent::Splash));
		}
	}

	// --- ride off the Knife-Edge rim: the gorge is not a shortcut ---
	if (!W.RowGorgeX.empty() && St.CrashT <= 0)
	{
		const int32_t GGI = std::max(0, std::min(W.NZ - 1,
			static_cast<int32_t>(Round((St.Z - W.Z0) / W.Step))));
		if (St.X > W.RowGorgeX[GGI] - 1.5)
		{
			St.CrashT = 0.7;
			Ev.push_back(MakeEv(EEvent::Gorge));
		}
	}

	// --- lost down a ravine / out of bounds -> gentle reset ---
	if (std::fabs(St.X) > X_HALF - 4 || St.Z < W.Z0 + 6)
	{
		St.CrashT = 0.4;
		Ev.push_back(MakeEv(EEvent::Reset));
	}

	// --- finish ---
	if (!St.bFinished && St.TrailIdx >= W.FinishIdx)
	{
		St.bFinished = true;
		St.FinishT = St.T + DT;
		Ev.push_back(MakeEv(EEvent::Finish));
	}
	St.T += DT;
}

// ================= AI riders =================

const FAIStyle& AIStyleArmand()
{
	static const FAIStyle S = { "Armand", 0x1F7A48, 1.00, 0.30, 26.0, false };
	return S;
}

const FAIStyle& AIStyleArthur()
{
	static const FAIStyle S = { "Arthur", 0xE8791D, 0.93, 0.24, 23.0, false };
	return S;
}

FGhost SimulateAI(const FWorld& W, const FAIStyle& Style)
{
	FRiderState St = NewRider(W);
	St.Power = Style.Power;
	St.bNoCrash = !Style.bAllowCrash;

	std::vector<uint8_t> Taken(W.Coins.size(), 0);
	std::vector<FGhostSample> Samples;
	std::vector<FEvent> Ev;
	int32_t Step = 0;
	const std::vector<FTrailPoint>& Tr = W.Trail;

	while (!St.bFinished && St.T < 300)
	{
		const double Speed = std::sqrt(St.VX * St.VX + St.VZ * St.VZ);
		const int32_t Ahead = std::max(3, static_cast<int32_t>(Round(Speed * 0.6 / TRAIL_DS)));
		const FTrailPoint& L = Tr[std::min(W.TrailN - 1, St.TrailIdx + Ahead)];
		const double Want = Atan2(L.X - St.X, L.Z - St.Z);
		const double DYaw = AngleWrap(Want - St.Yaw);

		// Upcoming curvature: how much the trail bends over the next 40 m.
		const FTrailPoint& A1 = Tr[std::min(W.TrailN - 1, St.TrailIdx + 2)];
		const FTrailPoint& A2 = Tr[std::min(W.TrailN - 1, St.TrailIdx + 8)];
		const double H1 = Atan2(A1.X - St.X, A1.Z - St.Z);
		const double H2 = Atan2(A2.X - A1.X, A2.Z - A1.Z);
		const double Curve = std::fabs(AngleWrap(H2 - H1));

		FInput In;
		In.bPedal = true;
		In.bBrake = (Curve > Style.BrakeCurve && Speed > 13) || Speed > Style.VBrake;
		In.bLeft  = DYaw > 0.06;      // +yaw turns toward +x, the rider's left
		In.bRight = DYaw < -0.06;
		In.bHop   = false;

		Ev.clear();
		StepRider(St, In, W, Ev, Taken);

		if (Step % 6 == 0)
		{
			Samples.push_back({ static_cast<int32_t>(Round(St.X * 10)),
			                    static_cast<int32_t>(Round(St.Y * 10)),
			                    static_cast<int32_t>(Round(St.Z * 10)),
			                    static_cast<int32_t>(Round(St.Yaw * 100)) });
		}
		Step++;
	}
	Samples.push_back({ static_cast<int32_t>(Round(St.X * 10)),
	                    static_cast<int32_t>(Round(St.Y * 10)),
	                    static_cast<int32_t>(Round(St.Z * 10)),
	                    static_cast<int32_t>(Round(St.Yaw * 100)) });

	FGhost G;
	G.Name = Style.Name;
	G.Colour = Style.Colour;
	G.Track = W.Def ? W.Def->Id : std::string();
	G.Samples = Samples;
	G.TimeMs = static_cast<int32_t>(Round(St.FinishT * 1000));
	G.Score = St.Score;
	G.Crashes = St.Crashes;
	G.CoinCount = St.CoinCount;
	return G;
}

// ================= ghosts =================

FGhostPos GhostPosAt(const FGhost& G, double TSec)
{
	if (G.Samples.empty()) return { 0, 0, 0, 0, true, true };

	const double Idx = TSec * GHOST_HZ;
	const int32_t I0 = static_cast<int32_t>(std::floor(Idx));
	const int32_t Last = static_cast<int32_t>(G.Samples.size()) - 1;
	if (I0 >= Last)
	{
		const FGhostSample& E = G.Samples[Last];
		return { E.X / 10.0, E.Y / 10.0, E.Z / 10.0, E.Yaw / 100.0, true, false };
	}
	const double T = Idx - I0;
	const FGhostSample& A = G.Samples[I0];
	const FGhostSample& B = G.Samples[I0 + 1];
	return {
		(A.X * (1 - T) + B.X * T) / 10.0,
		(A.Y * (1 - T) + B.Y * T) / 10.0,
		(A.Z * (1 - T) + B.Z * T) / 10.0,
		(A.Yaw * (1 - T) + B.Yaw * T) / 100.0,
		false, false
	};
}

std::string SanitizeName(const std::string& Name)
{
	std::string S;
	for (char C : Name)
	{
		const bool bOk = (C >= 'A' && C <= 'Z') || (C >= 'a' && C <= 'z')
		              || (C >= '0' && C <= '9') || C == ' ' || C == '_' || C == '-';
		if (bOk) S.push_back(C);
	}
	// .trim()
	size_t B = S.find_first_not_of(" \t\n\r\f\v");
	if (B == std::string::npos) return "Rider";
	size_t E = S.find_last_not_of(" \t\n\r\f\v");
	S = S.substr(B, E - B + 1);
	if (S.size() > 12) S = S.substr(0, 12);
	// JS slices to 12 AFTER trimming; a trailing space cannot survive that
	// because trim ran first, so no second trim is needed.
	return S.empty() ? "Rider" : S;
}

namespace
{
	const char* kB64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

	std::string Base64Encode(const std::string& In)
	{
		std::string Out;
		Out.reserve(((In.size() + 2) / 3) * 4);
		size_t I = 0;
		while (I + 2 < In.size())
		{
			const uint32_t V = (static_cast<uint8_t>(In[I]) << 16)
			                 | (static_cast<uint8_t>(In[I + 1]) << 8)
			                 |  static_cast<uint8_t>(In[I + 2]);
			Out += kB64[(V >> 18) & 63]; Out += kB64[(V >> 12) & 63];
			Out += kB64[(V >> 6) & 63];  Out += kB64[V & 63];
			I += 3;
		}
		const size_t Rem = In.size() - I;
		if (Rem == 1)
		{
			const uint32_t V = static_cast<uint8_t>(In[I]) << 16;
			Out += kB64[(V >> 18) & 63]; Out += kB64[(V >> 12) & 63]; Out += "==";
		}
		else if (Rem == 2)
		{
			const uint32_t V = (static_cast<uint8_t>(In[I]) << 16)
			                 | (static_cast<uint8_t>(In[I + 1]) << 8);
			Out += kB64[(V >> 18) & 63]; Out += kB64[(V >> 12) & 63];
			Out += kB64[(V >> 6) & 63];  Out += '=';
		}
		return Out;
	}

	bool Base64Decode(const std::string& In, std::string& Out)
	{
		int8_t Rev[256];
		std::memset(Rev, -1, sizeof(Rev));
		for (int I = 0; I < 64; I++) Rev[static_cast<uint8_t>(kB64[I])] = static_cast<int8_t>(I);

		uint32_t Buf = 0;
		int Bits = 0;
		Out.clear();
		for (char C : In)
		{
			if (C == '=' || C == '\n' || C == '\r') continue;
			const int8_t V = Rev[static_cast<uint8_t>(C)];
			if (V < 0) return false;
			Buf = (Buf << 6) | static_cast<uint32_t>(V);
			Bits += 6;
			if (Bits >= 8)
			{
				Bits -= 8;
				Out.push_back(static_cast<char>((Buf >> Bits) & 0xFF));
			}
		}
		return true;
	}
}

std::string PackGhost(const FGhost& G)
{
	// Delta-encode, then a JSON payload whose key order must match
	// JSON.stringify({v,n,t,ms,s}) byte for byte or the codes will not match
	// the ones the web game and server produce.
	std::string Samples;
	int32_t PX = 0, PY = 0, PZ = 0, PR = 0;
	for (size_t I = 0; I < G.Samples.size(); I++)
	{
		const FGhostSample& S = G.Samples[I];
		if (I) Samples += ';';
		char Buf[64];
		std::snprintf(Buf, sizeof(Buf), "%d,%d,%d,%d",
			S.X - PX, S.Y - PY, S.Z - PZ, S.Yaw - PR);
		Samples += Buf;
		PX = S.X; PY = S.Y; PZ = S.Z; PR = S.Yaw;
	}

	std::string Payload = "{\"v\":1,\"n\":\"" + G.Name + "\",\"t\":\"" + G.Track
	                    + "\",\"ms\":" + std::to_string(G.TimeMs)
	                    + ",\"s\":\"" + Samples + "\"}";
	return "ZR3G1." + Base64Encode(Payload);
}

namespace
{
	// Minimal extractor for the flat, machine-generated payload above. Not a
	// general JSON parser and does not need to be - but it must reject
	// anything it does not understand rather than guess.
	bool JsonString(const std::string& S, const std::string& Key, std::string& Out)
	{
		const std::string Pat = "\"" + Key + "\":\"";
		const size_t P = S.find(Pat);
		if (P == std::string::npos) return false;
		const size_t Start = P + Pat.size();
		const size_t End = S.find('"', Start);
		if (End == std::string::npos) return false;
		Out = S.substr(Start, End - Start);
		return true;
	}

	bool JsonNumber(const std::string& S, const std::string& Key, double& Out)
	{
		const std::string Pat = "\"" + Key + "\":";
		const size_t P = S.find(Pat);
		if (P == std::string::npos) return false;
		size_t Start = P + Pat.size();
		if (Start < S.size() && S[Start] == '"') return false;
		size_t End = Start;
		while (End < S.size() && (std::isdigit(static_cast<unsigned char>(S[End]))
		       || S[End] == '-' || S[End] == '+' || S[End] == '.'
		       || S[End] == 'e' || S[End] == 'E')) End++;
		if (End == Start) return false;
		try { Out = std::stod(S.substr(Start, End - Start)); }
		catch (...) { return false; }
		return true;
	}
}

bool UnpackGhost(const std::string& Code, FGhost& Out)
{
	std::string C = Code;
	// .trim()
	const size_t B = C.find_first_not_of(" \t\n\r\f\v");
	if (B == std::string::npos) return false;
	const size_t E = C.find_last_not_of(" \t\n\r\f\v");
	C = C.substr(B, E - B + 1);

	if (C.rfind("ZR3G1.", 0) != 0) return false;

	std::string Payload;
	if (!Base64Decode(C.substr(6), Payload)) return false;

	double V = 0;
	if (!JsonNumber(Payload, "v", V) || V != 1) return false;

	std::string Track;
	if (!JsonString(Payload, "t", Track)) return false;
	if (!FindTrack(Track)) return false;

	double Ms = 0;
	if (!JsonNumber(Payload, "ms", Ms)) return false;
	if (!std::isfinite(Ms) || Ms < 5000 || Ms > 900000) return false;

	std::string Name;
	if (!JsonString(Payload, "n", Name)) return false;

	std::string SamplesStr;
	if (!JsonString(Payload, "s", SamplesStr)) return false;

	std::vector<std::string> Parts;
	{
		size_t Start = 0;
		while (true)
		{
			const size_t P = SamplesStr.find(';', Start);
			if (P == std::string::npos) { Parts.push_back(SamplesStr.substr(Start)); break; }
			Parts.push_back(SamplesStr.substr(Start, P - Start));
			Start = P + 1;
		}
	}
	if (Parts.size() < 10 || Parts.size() > 30000) return false;

	std::vector<FGhostSample> Samples;
	Samples.reserve(Parts.size());
	double PX = 0, PY = 0, PZ = 0, PR = 0;
	for (const std::string& Part : Parts)
	{
		double Q[4];
		int Field = 0;
		size_t Start = 0;
		while (Field < 5)
		{
			const size_t P = Part.find(',', Start);
			const std::string Tok = (P == std::string::npos)
				? Part.substr(Start) : Part.substr(Start, P - Start);
			if (Field < 4)
			{
				if (Tok.empty()) return false;
				try { Q[Field] = std::stod(Tok); } catch (...) { return false; }
			}
			Field++;
			if (P == std::string::npos) break;
			Start = P + 1;
		}
		if (Field != 4) return false;    // exactly four fields per sample
		PX += Q[0]; PY += Q[1]; PZ += Q[2]; PR += Q[3];
		if (!std::isfinite(PX) || !std::isfinite(PY) || !std::isfinite(PZ) || !std::isfinite(PR))
			return false;
		Samples.push_back({ static_cast<int32_t>(PX), static_cast<int32_t>(PY),
		                    static_cast<int32_t>(PZ), static_cast<int32_t>(PR) });
	}

	Out.Name = SanitizeName(Name);
	Out.Track = Track;
	Out.TimeMs = static_cast<int32_t>(Round(Ms));
	Out.Samples = std::move(Samples);
	return true;
}

}	// namespace ZR
