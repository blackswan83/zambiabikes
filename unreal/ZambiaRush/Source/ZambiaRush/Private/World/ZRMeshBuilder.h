// ZRMeshBuilder — accumulates triangles for a ProceduralMeshComponent section.
//
// Every prop, the coins and the gates are built with this. Geometry is baked
// in WORLD space and merged per type, which for ~1,650 static props means a
// dozen draw calls and no instancing bookkeeping at all. Instanced meshes
// would need real UStaticMeshes, which would need assets, which the project
// deliberately does not have.

#pragma once

#include "CoreMinimal.h"

struct FZRMeshBuf
{
	TArray<FVector> Verts;
	TArray<int32> Tris;
	TArray<FVector> Normals;
	TArray<FVector2D> UVs;
	TArray<FLinearColor> Colours;

	bool IsEmpty() const { return Tris.Num() == 0; }

	/**
	 * Emits two triangles for a quad. Callers must order the corners so that
	 * (P1-P0) x (P2-P0) points along Normal — the same winding rule the
	 * terrain uses, so if it turns out to be backwards on real hardware both
	 * are backwards together and zr.Terrain.FlipWinding is the single fix.
	 */
	void AddQuad(const FVector& P0, const FVector& P1, const FVector& P2, const FVector& P3,
	             const FVector& Normal, const FLinearColor& Colour)
	{
		const int32 Base = Verts.Num();
		const FVector Ps[4] = { P0, P1, P2, P3 };
		const FVector2D Uv[4] = { {0,0}, {1,0}, {1,1}, {0,1} };
		for (int32 I = 0; I < 4; I++)
		{
			Verts.Add(Ps[I]);
			Normals.Add(Normal);
			UVs.Add(Uv[I]);
			Colours.Add(Colour);
		}
		Tris.Add(Base + 0); Tris.Add(Base + 1); Tris.Add(Base + 2);
		Tris.Add(Base + 0); Tris.Add(Base + 2); Tris.Add(Base + 3);
	}

	/** An axis-aligned-ish box, oriented by Rot, centred at Centre. */
	void AddBox(const FVector& Centre, const FVector& HalfExtent, const FRotator& Rot,
	            const FLinearColor& Colour)
	{
		const FQuat Q = Rot.Quaternion();
		auto P = [&](double SX, double SY, double SZ)
		{
			return Centre + Q.RotateVector(FVector(SX * HalfExtent.X, SY * HalfExtent.Y, SZ * HalfExtent.Z));
		};
		const FVector NX = Q.RotateVector(FVector::XAxisVector);
		const FVector NY = Q.RotateVector(FVector::YAxisVector);
		const FVector NZ = Q.RotateVector(FVector::ZAxisVector);

		AddQuad(P(+1,-1,-1), P(+1,+1,-1), P(+1,+1,+1), P(+1,-1,+1),  NX, Colour);
		AddQuad(P(-1,+1,-1), P(-1,-1,-1), P(-1,-1,+1), P(-1,+1,+1), -NX, Colour);
		AddQuad(P(+1,+1,-1), P(-1,+1,-1), P(-1,+1,+1), P(+1,+1,+1),  NY, Colour);
		AddQuad(P(-1,-1,-1), P(+1,-1,-1), P(+1,-1,+1), P(-1,-1,+1), -NY, Colour);
		AddQuad(P(-1,-1,+1), P(+1,-1,+1), P(+1,+1,+1), P(-1,+1,+1),  NZ, Colour);
		AddQuad(P(-1,+1,-1), P(+1,+1,-1), P(+1,-1,-1), P(-1,-1,-1), -NZ, Colour);
	}

	/** A tapered vertical prism — trunks, limbs, legs, necks. */
	void AddTaper(const FVector& Base, const FVector& Top, double RBase, double RTop,
	              int32 Sides, const FLinearColor& Colour)
	{
		const FVector Axis = (Top - Base).GetSafeNormal();
		FVector Side = FVector::CrossProduct(Axis, FVector::UpVector);
		if (Side.SizeSquared() < KINDA_SMALL_NUMBER)
		{
			Side = FVector::CrossProduct(Axis, FVector::ForwardVector);
		}
		Side = Side.GetSafeNormal();
		const FVector Up = FVector::CrossProduct(Axis, Side).GetSafeNormal();

		for (int32 I = 0; I < Sides; I++)
		{
			const double A0 = (2.0 * PI * I) / Sides;
			const double A1 = (2.0 * PI * (I + 1)) / Sides;
			const FVector D0 = Side * FMath::Cos(A0) + Up * FMath::Sin(A0);
			const FVector D1 = Side * FMath::Cos(A1) + Up * FMath::Sin(A1);
			AddQuad(Base + D0 * RBase, Base + D1 * RBase,
			        Top + D1 * RTop,   Top + D0 * RTop,
			        ((D0 + D1) * 0.5).GetSafeNormal(), Colour);
		}
	}

	/** A crude faceted blob — canopies, rocks, animal bodies. */
	void AddBlob(const FVector& Centre, const FVector& Radii, int32 Rings, int32 Segs,
	             const FLinearColor& Colour)
	{
		for (int32 R = 0; R < Rings; R++)
		{
			const double T0 = PI * R / Rings - HALF_PI;
			const double T1 = PI * (R + 1) / Rings - HALF_PI;
			for (int32 S = 0; S < Segs; S++)
			{
				const double A0 = 2.0 * PI * S / Segs;
				const double A1 = 2.0 * PI * (S + 1) / Segs;
				auto Pt = [&](double Theta, double Phi)
				{
					return Centre + FVector(
						Radii.X * FMath::Cos(Theta) * FMath::Cos(Phi),
						Radii.Y * FMath::Cos(Theta) * FMath::Sin(Phi),
						Radii.Z * FMath::Sin(Theta));
				};
				const FVector V0 = Pt(T0, A0), V1 = Pt(T0, A1);
				const FVector V2 = Pt(T1, A1), V3 = Pt(T1, A0);
				const FVector N = ((V0 + V1 + V2 + V3) * 0.25 - Centre).GetSafeNormal();
				AddQuad(V0, V1, V2, V3, N, Colour);
			}
		}
	}
};
