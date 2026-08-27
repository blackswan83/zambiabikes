// ZRConvert — the one place JS-space becomes Unreal-space.
//
// ZRCore works in the browser game's coordinates: right-handed, Y-up, metres,
// +z downhill. Unreal is left-handed, Z-up, centimetres. Everything in ZRCore
// stays in the former; conversion happens here and nowhere else.
//
// THE TRAP: the obvious mapping (X,Y,Z)ue = (z,x,y)js is an EVEN permutation
// between coordinate systems of opposite handedness, which MIRRORS the world.
// The trail wiggles the wrong way, the core's "screen-right is world -x"
// assumption (js/game3d-core.js:699) inverts, and steering feels backwards —
// which is very tempting to "fix" with a sign flip on the steering input,
// after which the player is fine and the AI, which shares stepRider3, rides
// into the trees. The mapping below is odd, and correct.

#pragma once

#include "CoreMinimal.h"
#include "Core/ZRCore.h"

namespace ZRConv
{
	// The browser game is in metres. Unreal is in centimetres.
	constexpr double MetresToUU = 100.0;

	/** JS-space position (metres) -> Unreal world position (centimetres). */
	FORCEINLINE FVector Pos(double JsX, double JsY, double JsZ)
	{
		return FVector(JsZ * MetresToUU, -JsX * MetresToUU, JsY * MetresToUU);
	}

	FORCEINLINE FVector Pos(const ZR::FRiderState& St)
	{
		return Pos(St.X, St.Y, St.Z);
	}

	FORCEINLINE FVector Pos(const ZR::FTrailPoint& P)
	{
		return Pos(P.X, P.Y, P.Z);
	}

	/** A JS-space direction or normal (unitless) -> Unreal direction. */
	FORCEINLINE FVector Dir(double JsX, double JsY, double JsZ)
	{
		return FVector(JsZ, -JsX, JsY);
	}

	FORCEINLINE FVector Dir(const ZR::FNormal& N)
	{
		return Dir(N.X, N.Y, N.Z);
	}

	/**
	 * JS yaw (radians, 0 = facing +z, increasing turns toward +x) -> Unreal yaw
	 * in degrees. Negated for the same handedness reason as the position swap.
	 */
	FORCEINLINE double YawDeg(double JsYawRadians)
	{
		return -FMath::RadiansToDegrees(JsYawRadians);
	}

	/**
	 * Theme colours in the track table are sRGB hex, and Three.js r152+
	 * converts them to linear on `new THREE.Color()`. Unreal's
	 * CreateMeshSection_LinearColor does not, and the VertexColor material node
	 * returns whatever it was given, linearly. Skip this conversion and every
	 * colour in the game comes out washed out and desaturated — individually
	 * still "greenish", which makes it a horrible thing to diagnose.
	 */
	FORCEINLINE FLinearColor FromHexSRGB(uint32 Hex)
	{
		return FLinearColor::FromSRGBColor(FColor(
			static_cast<uint8>((Hex >> 16) & 0xFF),
			static_cast<uint8>((Hex >> 8) & 0xFF),
			static_cast<uint8>(Hex & 0xFF)));
	}
}
