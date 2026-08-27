// zrcore_verify.cpp — the C++ half of the ZRCore parity check.
//
// Produces byte-identical output to Tools/zrcore_reference.js, which runs the
// shipping js/game3d-core.js under Node. If `diff` is empty, the C++ port is
// bit-exact with the browser game: same mountain, same trail, same props,
// same physics, same AI, same Ghost Codes.
//
// Do not soften this into a tolerance comparison. With ZRMath supplying
// V8-exact sin/cos/atan2, exactness is achievable, and a tolerance is a place
// for bugs to hide.
//
//   g++ -O2 -std=c++17 -I ../Source/ZambiaRush/Private/Core \
//       zrcore_verify.cpp ../Source/ZambiaRush/Private/Core/ZR{Core,Math}.cpp \
//       -o zrcore_verify
//   node zrcore_reference.js miombo > ref.txt
//   ./zrcore_verify miombo > got.txt
//   diff ref.txt got.txt && echo BIT-EXACT

#include "ZRCore.h"
#include "ZRMath.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

using namespace ZR;

static std::string D64(double X)
{
	uint64_t B;
	std::memcpy(&B, &X, 8);
	char Out[17];
	for (int I = 0; I < 8; I++)
	{
		std::snprintf(Out + I * 2, 3, "%02x", static_cast<unsigned>((B >> (8 * I)) & 0xFF));
	}
	return std::string(Out, 16);
}

static std::string F32(float F)
{
	uint32_t B;
	std::memcpy(&B, &F, 4);
	char Out[16];
	std::snprintf(Out, sizeof(Out), "%08x", B);
	return Out;
}

static const char* EventName(const FEvent& E)
{
	switch (E.Type)
	{
	case EEvent::Hop:       return "hop";
	case EEvent::TakeOff:   return "takeoff";
	case EEvent::Respawn:   return "respawn";
	case EEvent::Gate:      return "gate";
	case EEvent::Coin:      return "coin";
	case EEvent::BigAir:    return "bigair";
	case EEvent::TurboOn:   return "turboOn";
	case EEvent::TurboOff:  return "turboOff";
	case EEvent::Splash:    return "splash";
	case EEvent::Gorge:     return "gorge";
	case EEvent::Reset:     return "reset";
	case EEvent::Finish:    return "finish";
	case EEvent::Land:      return "land";
	case EEvent::Crash:     return "crash";
	case EEvent::Trick:     return "trick";
	}
	return "?";
}

static std::string EventString(const FEvent& E)
{
	std::string S = EventName(E);
	if (E.Type == EEvent::Land)  S += E.bHard ? ":hard" : ":clean";
	if (E.Type == EEvent::Crash)
	{
		if (E.Cause == FEvent::ECause::TrickLanding) S += ":trick";
		else if (E.Cause == FEvent::ECause::Landing) S += ":landing";
		else { S += ":"; S += PropName(E.PropCause); }
	}
	if (E.Type == EEvent::Trick)
	{
		S += ":" + std::to_string(E.Flips) + ":" + std::to_string(E.Spins)
		   + ":" + std::to_string(E.Pts);
	}
	return S;
}

int main(int Argc, char** Argv)
{
	const std::string TrackId = Argc > 1 ? Argv[1] : "miombo";
	const FTrackDef* Def = FindTrack(TrackId);
	if (!Def) { std::fprintf(stderr, "unknown track: %s\n", TrackId.c_str()); return 2; }

	std::string Out;
	Out.reserve(8u << 20);
	auto Emit = [&Out](const std::string& S) { Out += S; Out += '\n'; };

	// ---------- world ----------
	const FWorld W = BuildWorld(*Def);

	Emit("WORLD " + std::to_string(W.NX) + " " + std::to_string(W.NZ) + " " + D64(W.Z0)
	     + " " + D64(W.X0) + " " + D64(W.Step) + " " + std::to_string(W.TrailN)
	     + " " + std::to_string(W.FinishIdx));

	for (size_t I = 0; I < W.H.size(); I++)  Emit("H " + std::to_string(I) + " " + F32(W.H[I]));
	for (size_t I = 0; I < W.TD.size(); I++) Emit("D " + std::to_string(I) + " " + F32(W.TD[I]));

	for (int32_t I = 0; I < W.TrailN; I++)
	{
		const FTrailPoint& P = W.Trail[I];
		Emit("T " + std::to_string(I) + " " + D64(P.X) + " " + D64(P.Y) + " " + D64(P.Z)
		     + " " + D64(P.Yaw) + " " + D64(P.Dist));
	}
	{
		std::string L;
		for (size_t I = 0; I < W.Kickers.size(); I++)
		{
			if (I) L += ",";
			L += std::to_string(W.Kickers[I]);
		}
		Emit("KICKERS " + std::to_string(W.Kickers.size()) + " " + L);
		L.clear();
		for (size_t I = 0; I < W.Gates.size(); I++)
		{
			if (I) L += ",";
			L += std::to_string(W.Gates[I]);
		}
		Emit("GATES " + std::to_string(W.Gates.size()) + " " + L);
	}
	Emit("NCOINS " + std::to_string(W.Coins.size()));
	for (size_t I = 0; I < W.Coins.size(); I++)
	{
		const FCoin& C = W.Coins[I];
		Emit("C " + std::to_string(I) + " " + D64(C.X) + " " + D64(C.Y) + " " + D64(C.Z));
	}
	Emit("NPROPS " + std::to_string(W.Props.size()));
	for (size_t I = 0; I < W.Props.size(); I++)
	{
		const FProp& P = W.Props[I];
		Emit("P " + std::to_string(I) + " " + PropName(P.Type) + " " + D64(P.X) + " " + D64(P.Z)
		     + " " + D64(P.Y) + " " + D64(P.S) + " " + D64(P.Rot) + " " + D64(P.R));
	}

	// ---------- terrain queries, including off-grid and out-of-bounds ----------
	{
		FRandom R(4242);
		for (int I = 0; I < 3000; I++)
		{
			const double X = (R() * 2 - 1) * 300.0;
			const double Z = R() * (Def->Length + 200) - 80.0;
			Emit("Q " + D64(X) + " " + D64(Z) + " " + D64(HeightAt(W, X, Z))
			     + " " + D64(TrailDistAt(W, X, Z)));
			const FNormal N = NormalAt(W, X, Z);
			Emit("N " + D64(N.X) + " " + D64(N.Y) + " " + D64(N.Z));
		}
	}

	// ---------- AI ghosts ----------
	{
		const FAIStyle* Styles[2] = { &AIStyleArmand(), &AIStyleArthur() };
		const char* Keys[2] = { "armand", "arthur" };
		for (int K = 0; K < 2; K++)
		{
			const FGhost G = SimulateAI(W, *Styles[K]);
			Emit("AI " + std::string(Keys[K]) + " " + std::to_string(G.TimeMs) + " "
			     + std::to_string(G.Score) + " " + std::to_string(G.Crashes) + " "
			     + std::to_string(G.CoinCount) + " " + std::to_string(G.Samples.size()));
			for (size_t I = 0; I < G.Samples.size(); I++)
			{
				const FGhostSample& S = G.Samples[I];
				Emit("S " + std::to_string(I) + " " + std::to_string(S.X) + ","
				     + std::to_string(S.Y) + "," + std::to_string(S.Z) + "," + std::to_string(S.Yaw));
			}
			Emit("GCODE " + std::string(Keys[K]) + " " + PackGhost(G));
		}
	}

	// ---------- scripted player run ----------
	{
		FRiderState St = NewRider(W);
		std::vector<uint8_t> Taken(W.Coins.size(), 0);
		std::vector<FEvent> Ev;
		for (int Step = 0; Step < 6000; Step++)
		{
			const bool bAloft = !St.bOnGround;
			FInput In;
			In.bPedal = (Step % 97) < 80;
			In.bBrake = (Step % 211) < 25;
			In.bLeft  = (Step % 53) < 18;
			In.bRight = (Step % 71) < 15;
			In.bHop   = (Step % 137) == 0;
			In.bTurbo = (Step % 17) == 0;
			In.bFlipF = bAloft && In.bPedal;  In.bFlipB = bAloft && In.bBrake;
			In.bSpinL = bAloft && In.bLeft;   In.bSpinR = bAloft && In.bRight;

			Ev.clear();
			StepRider(St, In, W, Ev, Taken);

			if (Step % 30 == 0)
			{
				std::string L = "R " + std::to_string(Step);
				const double Dv[] = { St.X, St.Y, St.Z, St.VX, St.VY, St.VZ, St.Yaw, St.AirT,
					St.CrashT, St.HopCd, St.TrailD, St.T, St.FinishT, St.WheelSpin, St.Lean,
					St.TurboT, St.TurboCd, St.Throttle, St.Pitch, St.PitchV, St.Spin, St.SpinV };
				for (double V : Dv) L += " " + D64(V);
				const int32_t Iv[] = { St.Crashes, St.TrailIdx, St.RespawnIdx, St.Score,
					St.CoinCount, St.BigAirs, St.CoinPtr, St.TurboTaps, St.TurboUses,
					St.Tricks, St.TrickPts };
				for (int32_t V : Iv) L += " " + std::to_string(V);
				L += " ";
				L += (St.bOnGround ? '1' : '0');
				L += (St.bFinished ? '1' : '0');
				L += (St.bOffTrail ? '1' : '0');
				Emit(L);
			}
			std::string EvStr;
			for (size_t I = 0; I < Ev.size(); I++)
			{
				if (I) EvStr += "|";
				EvStr += EventString(Ev[I]);
			}
			Emit("EV " + std::to_string(Step) + " " + EvStr);
		}
	}

	// ---------- ghost codec round-trip ----------
	{
		const FGhost G = SimulateAI(W, AIStyleArmand());
		const std::string Code = PackGhost(G);
		FGhost Back;
		if (UnpackGhost(Code, Back))
		{
			Emit("ROUNDTRIP " + Back.Name + " " + Back.Track + " " + std::to_string(Back.TimeMs)
			     + " " + std::to_string(Back.Samples.size()));
		}
		else Emit("ROUNDTRIP null");

		const char* Bad[] = { "", "nope", "ZR3G1.", "ZR3G1.!!!!", "ZR3G1.eyJ2IjoyfQ==" };
		for (const char* B : Bad)
		{
			FGhost Tmp;
			Emit("REJECT \"" + std::string(B) + "\" " + (UnpackGhost(B, Tmp) ? "accepted" : "null"));
		}
		const char* Names[] = { "  Armand  ", "<script>x", "", "ThisNameIsFarTooLong", "a_b-c 1" };
		for (const char* N : Names)
		{
			Emit("SANITIZE \"" + std::string(N) + "\" \"" + SanitizeName(N) + "\"");
		}
	}

	std::fwrite(Out.data(), 1, Out.size(), stdout);
	return 0;
}
