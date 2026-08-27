// ZRCore — the Zambia Rush simulation, transliterated from js/game3d-core.js.
//
// This file has ZERO Unreal dependencies on purpose: plain double, plain
// std::vector, no UObject, no FVector. Two reasons.
//
//   1. It can be compiled and tested WITHOUT Unreal, on any machine, against
//      the JavaScript original running under Node. Tools/zrcore_verify.cpp
//      does exactly that and demands bit-exact agreement. That is the only
//      way to know the port is faithful.
//   2. It stays a readable sibling of js/game3d-core.js so the two can be
//      diffed by eye forever.
//
// Units are metres, +z is downhill along the mountain, +y is up — the SAME
// right-handed, Y-up, metre-scale space as the browser game. Conversion to
// Unreal's left-handed, Z-up, centimetre space happens at the transform
// boundary only (see ZRConvert.h). Do not "fix" the coordinates in here.

#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

namespace ZR
{
	// ---- deterministic PRNG ---------------------------------------------
	// mulberry32 uses Math.imul, which IS an exact 32-bit wrapping multiply,
	// so this is exact uint32 arithmetic. The state MUST be unsigned: with a
	// signed int, `a + 0x6D2B79F5` is signed overflow (UB), and clang will
	// exploit that at -O2.
	//
	// Note the trap next door in ZRCore.cpp: hash2() looks like the same kind
	// of integer hash and is NOT. Read its comment before touching either.
	class FRandom
	{
	public:
		explicit FRandom(uint32_t InSeed) : State(InSeed) {}
		double operator()();
	private:
		uint32_t State;
	};

	// ---- track data ------------------------------------------------------

	enum class EProp : uint8_t
	{
		Miombo, Baobab, Acacia, Palm, Bush, Fern, Grass, Reed, Rock, Termite,
		Hippo, Elephant, Croc, Antelope, Zebra, Giraffe, Rhino
	};

	const char* PropName(EProp Type);

	struct FThemeColour { uint32_t Sky, SkyLow, Fog, Sun, Ambient, Grass, GrassDry, Dirt, DirtDark,
		Rock, Trunk, Canopy, Canopy2, Accent, Water; };

	struct FTheme
	{
		FThemeColour Colour{};
		double FogNear = 60.0, FogFar = 420.0;
		double SunPos[3] = { 140.0, 220.0, -160.0 };
		double Turbidity = 4.0, Rayleigh = 1.4, MieCoeff = 0.003, MieG = 0.78;
		double CloudCover = 0.42, Exposure = 0.52;
		bool bBats = false, bGroundMist = false;
	};

	struct FHazardDef { EProp Type; double From, Every, Lat, Spread, R; };
	struct FRiverDef  { bool bValid = false; double Offset = 0, Width = 0, Depth = 0; };
	struct FGorgeDef  { bool bValid = false; double FromFrac = 0, Offset = 0, Width = 0, Depth = 0; };

	struct FTrackDef
	{
		std::string Id, Name, Level, LevelLabel, Desc;
		uint32_t Seed = 0;
		double Length = 0, Slope = 0, Wobble = 0, KickerEvery = 0;
		std::vector<FHazardDef> Hazards;
		FRiverDef River;
		FGorgeDef Gorge;
		FTheme Theme;
	};

	const FTrackDef* FindTrack(const std::string& Id);
	const std::vector<std::string>& TrackOrder();

	// ---- world -----------------------------------------------------------

	struct FTrailPoint { double X = 0, Z = 0, Y = 0, Yaw = 0, Dist = 0; };
	struct FProp  { EProp Type; double X, Z, Y, S, Rot, R; };
	struct FCoin  { double X, Y, Z; };

	struct FWorld
	{
		const FTrackDef* Def = nullptr;
		int32_t NX = 0, NZ = 0;
		double Z0 = 0, X0 = 0, Step = 0;

		// float32, NOT double. js/game3d-core.js stores these in Float32Array,
		// so every value is rounded to float32 on store and the physics reads
		// float32 back — the trail's own y is re-sampled from this grid at
		// line 370. "Upgrading" these to double diverges from the browser game
		// immediately and visibly. Arithmetic stays double; only storage is
		// float.
		std::vector<float> H;
		std::vector<float> TD;
		std::vector<float> RowWaterY, RowEdgeX, RowGorgeX;
		std::vector<float> RiverEdgeX, WaterY;
		bool bHasRiver = false, bHasGorge = false;

		std::vector<FTrailPoint> Trail;
		int32_t TrailN = 0, FinishIdx = 0;
		std::vector<int32_t> Kickers, Gates;
		std::vector<FProp> Props;
		std::vector<FCoin> Coins;

		// Spatial hash of solid props. JS keys this with the string
		// "cx,cz"; we pack the two int32 cell coords into an int64 instead.
		// Bucket contents stay a vector because insertion order is
		// load-bearing — the physics breaks on the first hit it finds.
		std::unordered_map<int64_t, std::vector<int32_t>> Hash;
		double HashCell = 8.0;
	};

	FWorld BuildWorld(const FTrackDef& Def);

	double HeightAt(const FWorld& W, double X, double Z);
	double TrailDistAt(const FWorld& W, double X, double Z);
	struct FNormal { double X, Y, Z; };
	FNormal NormalAt(const FWorld& W, double X, double Z);

	// Cheap trail-only build for the course map — no heightfield.
	struct FTrailPreview
	{
		std::vector<FTrailPoint> Pts;
		double MinX = 0, MaxX = 0, ZEnd = 0;
		int32_t Drop = 0, Kickers = 0;
	};
	FTrailPreview TrailPreview(const FTrackDef& Def);

	// ---- riders ----------------------------------------------------------

	struct FBikeStats
	{
		double Pedal = 1, VCap = 1, Brake = 1, Steer = 1, Roll = 1, Rough = 1;
		double LandSoft = 0, Hop = 1;
		double TurboTap = 1, TurboWindow = 1, TurboCool = 1, TurboPow = 1;
	};

	struct FRiderState
	{
		double X = 0, Y = 0, Z = 0;
		double VX = 0, VY = 0, VZ = 0;
		double Yaw = 0;
		bool bOnGround = true;
		double AirT = 0, CrashT = 0, HopCd = 0;
		int32_t Crashes = 0;
		int32_t TrailIdx = 2, RespawnIdx = 2;
		double TrailD = 0;
		double T = 0;
		bool bFinished = false;
		double FinishT = 0;
		int32_t Score = 0, CoinCount = 0, BigAirs = 0, CoinPtr = 0;
		double WheelSpin = 0, Lean = 0, Power = 1;
		bool bNoCrash = false;
		double TurboT = 0, TurboCd = 0, Throttle = 0;
		int32_t TurboTaps = 0, TurboUses = 0;
		double Pitch = 0, PitchV = 0, Spin = 0, SpinV = 0;
		int32_t Tricks = 0, TrickPts = 0;
		bool bOffTrail = false;
		FBikeStats Stats;
	};

	struct FInput
	{
		bool bPedal = false, bBrake = false, bLeft = false, bRight = false;
		bool bHop = false, bTurbo = false;
		bool bFlipF = false, bFlipB = false, bSpinL = false, bSpinR = false;
	};

	enum class EEvent : uint8_t
	{
		Hop, TakeOff, Land, Crash, Respawn, Gate, Coin, BigAir, Trick,
		TurboOn, TurboOff, Splash, Gorge, Reset, Finish
	};

	struct FEvent
	{
		EEvent Type;
		// Land: bHard. Crash: CrashReason.
		bool bHard = false;
		// Trick payload.
		int32_t Flips = 0, Spins = 0, Pts = 0;
		bool bBack = false, bCombo = false;
		// Crash cause: a prop type, or one of the synthetic reasons below.
		enum class ECause : uint8_t { Landing, TrickLanding, Prop } Cause = ECause::Landing;
		EProp PropCause = EProp::Rock;
		// Coin: which coin, so the renderer can take it off the hill. Carried
		// here rather than diffed out of the Taken array by the caller.
		int32_t Index = -1;
	};

	FRiderState NewRider(const FWorld& W);

	// Advances one fixed 1/60 s step. `Taken` is the shared coin-collected
	// flag array, one entry per world coin.
	void StepRider(FRiderState& St, const FInput& In, const FWorld& W,
	               std::vector<FEvent>& Ev, std::vector<uint8_t>& Taken);

	// ---- AI riders and ghosts -------------------------------------------

	struct FAIStyle
	{
		std::string Name;
		uint32_t Colour = 0;
		double Power = 1.0, BrakeCurve = 0.30, VBrake = 26.0;
		bool bAllowCrash = false;
	};

	const FAIStyle& AIStyleArmand();
	const FAIStyle& AIStyleArthur();

	// One ghost sample: x*10, y*10, z*10, yaw*100, all rounded to int.
	struct FGhostSample { int32_t X, Y, Z, Yaw; };

	struct FGhost
	{
		std::string Name;
		std::string Track;
		uint32_t Colour = 0;
		std::vector<FGhostSample> Samples;
		int32_t TimeMs = 0;
		int32_t Score = 0, Crashes = 0, CoinCount = 0;
	};

	FGhost SimulateAI(const FWorld& W, const FAIStyle& Style);

	struct FGhostPos { double X, Y, Z, Yaw; bool bDone, bEmpty; };
	FGhostPos GhostPosAt(const FGhost& G, double TSec);

	std::string PackGhost(const FGhost& G);
	bool UnpackGhost(const std::string& Code, FGhost& Out);
	std::string SanitizeName(const std::string& Name);

	// ---- constants (mirrors js/game3d-core.js:585-635) --------------------

	constexpr double DT           = 1.0 / 60.0;
	constexpr double GRAV         = 14.5;
	constexpr double PEDAL_A      = 13.0;
	constexpr double VCAP         = 21.0;
	constexpr double BRAKE_A      = 20.0;
	constexpr double DRAG         = 0.011;
	constexpr double ROLL         = 0.4;
	constexpr double STEER_RATE   = 2.3;
	constexpr double HOP_V        = 4.9;
	constexpr double CRASH_IMPACT = 11.5;

	constexpr double TURBO_WINDOW   = 10.0;
	constexpr double TURBO_COOLDOWN = 18.0;
	constexpr double TURBO_TAP      = 0.10;
	constexpr double TURBO_DECAY    = 0.8;
	constexpr double TURBO_PEDAL    = 0.8;
	constexpr double TURBO_VCAP     = 0.34;
	constexpr double TURBO_THRUST   = 9.0;

	constexpr double FLIP_ACC = 12.0, FLIP_MAX = 11.0;
	constexpr double SPIN_ACC = 11.0, SPIN_MAX = 9.0;
	constexpr int32_t TRICK_FLIP_PTS = 150, TRICK_SPIN_PTS = 120;
	constexpr double TRICK_SLOP = 2.0, TRICK_ROUGH = 0.9;

	constexpr double GRID_STEP = 4.0;
	constexpr double X_HALF    = 240.0;
	constexpr double TRAIL_DS  = 5.0;
	constexpr double CARVE_R   = 9.0;
	constexpr int32_t GHOST_HZ = 10;
}
