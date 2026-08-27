// Geometry recipes for everything that grows on or wanders across the hill.
//
// The browser game builds these from merged Three.js primitives, with
// recursive tapering branches for the msasa trees and a counter-shaded hide
// for the animals (js/game3d.js buildElephant, buildGiraffe, buildCroc, ...).
// These are the same silhouettes at lower fidelity: recognisable at riding
// speed, which is the only time anyone sees them. Porting the detailed
// builders is a later milestone and touches nothing but this header.

#pragma once

#include "CoreMinimal.h"
#include "Core/ZRCore.h"
#include "Game/ZRConvert.h"
#include "World/ZRMeshBuilder.h"

namespace ZRProp
{
	inline FLinearColor Shade(const FLinearColor& C, double K)
	{
		return FLinearColor(C.R * K, C.G * K, C.B * K, 1.0f);
	}

	/** A four-legged animal: body, head, optional neck, four legs, a tail. */
	inline void AddBeast(FZRMeshBuf& B, const FVector& Foot, double Yaw,
		double BodyLen, double BodyH, double BodyW, double LegLen, double NeckLen,
		double HeadLen, const FLinearColor& Hide)
	{
		const FQuat Q(FVector::UpVector, Yaw);
		auto P = [&](double Fwd, double Side, double Up)
		{
			return Foot + Q.RotateVector(FVector(Fwd, Side, 0.0)) + FVector(0, 0, Up);
		};
		const FLinearColor Belly = Shade(Hide, 1.25);
		const FLinearColor Dark  = Shade(Hide, 0.72);

		const double BodyZ = LegLen + BodyH * 0.5;
		B.AddBlob(P(0, 0, BodyZ), FVector(BodyLen * 0.5, BodyW * 0.5, BodyH * 0.5), 4, 7, Hide);
		B.AddBlob(P(0, 0, BodyZ - BodyH * 0.32), FVector(BodyLen * 0.42, BodyW * 0.42, BodyH * 0.22), 3, 6, Belly);

		// Legs, splayed slightly so it does not read as a table.
		for (int32 I = 0; I < 4; I++)
		{
			const double Fwd  = (I < 2 ? 1.0 : -1.0) * BodyLen * 0.32;
			const double Side = (I % 2 == 0 ? 1.0 : -1.0) * BodyW * 0.34;
			B.AddTaper(P(Fwd, Side, 0.0), P(Fwd, Side * 0.85, LegLen),
			           LegLen * 0.13, LegLen * 0.10, 5, Dark);
		}

		// Neck and head.
		const FVector NeckBase = P(BodyLen * 0.42, 0, BodyZ + BodyH * 0.18);
		const FVector NeckTop  = P(BodyLen * 0.42 + NeckLen * 0.45, 0, BodyZ + BodyH * 0.18 + NeckLen);
		if (NeckLen > 0.01)
		{
			B.AddTaper(NeckBase, NeckTop, BodyW * 0.22, BodyW * 0.15, 6, Hide);
		}
		B.AddBlob(NeckTop + FVector(0, 0, HeadLen * 0.2),
		          FVector(HeadLen * 0.5, HeadLen * 0.3, HeadLen * 0.32), 3, 6, Hide);

		// Tail.
		B.AddTaper(P(-BodyLen * 0.48, 0, BodyZ + BodyH * 0.15),
		           P(-BodyLen * 0.62, 0, BodyZ - BodyH * 0.25),
		           BodyW * 0.07, BodyW * 0.03, 4, Dark);
	}

	/** Builds one prop's geometry into B, in Unreal world space. */
	inline void Add(FZRMeshBuf& B, const ZR::FProp& P, const ZR::FTheme& Theme)
	{
		const FVector Foot = ZRConv::Pos(P.X, P.Y, P.Z);
		const double S = P.S;
		const double Yaw = P.Rot;
		const double M = ZRConv::MetresToUU;

		const FLinearColor Trunk   = ZRConv::FromHexSRGB(Theme.Colour.Trunk);
		const FLinearColor Canopy  = ZRConv::FromHexSRGB(Theme.Colour.Canopy);
		const FLinearColor Canopy2 = ZRConv::FromHexSRGB(Theme.Colour.Canopy2);
		const FLinearColor Rock    = ZRConv::FromHexSRGB(Theme.Colour.Rock);
		const FLinearColor Grass   = ZRConv::FromHexSRGB(Theme.Colour.Grass);
		const FLinearColor Dry     = ZRConv::FromHexSRGB(Theme.Colour.GrassDry);

		switch (P.Type)
		{
		case ZR::EProp::Miombo:
		{
			// Msasa: a clear trunk, then a broad flattish crown.
			const double H = 6.5 * S * M;
			B.AddTaper(Foot, Foot + FVector(0, 0, H), 0.22 * S * M, 0.13 * S * M, 6, Trunk);
			for (int32 I = 0; I < 3; I++)
			{
				const double A = Yaw + I * 2.094;
				B.AddBlob(Foot + FVector(FMath::Cos(A) * 0.9 * S * M, FMath::Sin(A) * 0.9 * S * M,
					H * (0.92 + 0.06 * I)),
					FVector(2.3 * S * M, 2.3 * S * M, 1.1 * S * M), 3, 7,
					I % 2 ? Canopy : Canopy2);
			}
			break;
		}
		case ZR::EProp::Baobab:
		{
			// Fat, short, and unmistakable — the upside-down tree.
			const double H = 7.0 * S * M;
			B.AddTaper(Foot, Foot + FVector(0, 0, H), 1.5 * S * M, 0.55 * S * M, 9, Trunk);
			for (int32 I = 0; I < 5; I++)
			{
				const double A = Yaw + I * 1.257;
				const FVector Tip = Foot + FVector(FMath::Cos(A) * 2.6 * S * M,
					FMath::Sin(A) * 2.6 * S * M, H + 1.5 * S * M);
				B.AddTaper(Foot + FVector(0, 0, H), Tip, 0.24 * S * M, 0.07 * S * M, 4, Trunk);
			}
			break;
		}
		case ZR::EProp::Acacia:
		{
			const double H = 5.2 * S * M;
			B.AddTaper(Foot, Foot + FVector(0, 0, H), 0.26 * S * M, 0.12 * S * M, 6, Trunk);
			B.AddBlob(Foot + FVector(0, 0, H + 0.4 * S * M),
				FVector(3.2 * S * M, 3.2 * S * M, 0.7 * S * M), 3, 9, Canopy);
			break;
		}
		case ZR::EProp::Palm:
		{
			const double H = 6.0 * S * M;
			B.AddTaper(Foot, Foot + FVector(0.5 * S * M, 0, H), 0.20 * S * M, 0.14 * S * M, 6, Trunk);
			for (int32 I = 0; I < 7; I++)
			{
				const double A = Yaw + I * 0.897;
				const FVector Top = Foot + FVector(0.5 * S * M, 0, H);
				B.AddTaper(Top, Top + FVector(FMath::Cos(A) * 2.2 * S * M,
					FMath::Sin(A) * 2.2 * S * M, 0.4 * S * M),
					0.16 * S * M, 0.03 * S * M, 3, Canopy);
			}
			break;
		}
		case ZR::EProp::Bush:
			B.AddBlob(Foot + FVector(0, 0, 0.55 * S * M),
				FVector(0.95 * S * M, 0.95 * S * M, 0.62 * S * M), 3, 6, Canopy2);
			break;
		case ZR::EProp::Fern:
			for (int32 I = 0; I < 4; I++)
			{
				const double A = Yaw + I * 1.571;
				B.AddTaper(Foot, Foot + FVector(FMath::Cos(A) * 0.55 * S * M,
					FMath::Sin(A) * 0.55 * S * M, 0.75 * S * M),
					0.10 * S * M, 0.02 * S * M, 3, Canopy);
			}
			break;
		case ZR::EProp::Grass:
		case ZR::EProp::Reed:
		{
			// Crossed blades. Cheap, and there are a lot of them.
			const bool bReed = (P.Type == ZR::EProp::Reed);
			const double H = (bReed ? 1.7 : 0.5) * S * M;
			const double W = (bReed ? 0.10 : 0.34) * S * M;
			const FLinearColor C = bReed ? Canopy2 : Dry;
			for (int32 I = 0; I < 2; I++)
			{
				const double A = Yaw + I * 1.571;
				const FVector Side(FMath::Cos(A) * W, FMath::Sin(A) * W, 0);
				const FVector N(-FMath::Sin(A), FMath::Cos(A), 0);
				B.AddQuad(Foot - Side, Foot + Side,
				          Foot + Side + FVector(0, 0, H), Foot - Side + FVector(0, 0, H), N, C);
			}
			break;
		}
		case ZR::EProp::Rock:
			B.AddBlob(Foot + FVector(0, 0, 0.45 * S * M),
				FVector(1.0 * S * M, 0.85 * S * M, 0.7 * S * M), 2, 5, Rock);
			break;
		case ZR::EProp::Termite:
			B.AddTaper(Foot, Foot + FVector(0, 0, 2.1 * S * M),
				0.75 * S * M, 0.06 * S * M, 7, ZRConv::FromHexSRGB(Theme.Colour.DirtDark));
			break;

		// ---- wildlife ----
		case ZR::EProp::Hippo:
			AddBeast(B, Foot, Yaw, 3.3 * M, 1.5 * M, 1.6 * M, 0.5 * M, 0.0, 1.2 * M,
				FLinearColor::FromSRGBColor(FColor(0x6B, 0x5B, 0x5B)));
			break;
		case ZR::EProp::Elephant:
			AddBeast(B, Foot, Yaw, 4.0 * M, 2.4 * M, 2.0 * M, 1.6 * M, 0.3 * M, 1.4 * M,
				FLinearColor::FromSRGBColor(FColor(0x8A, 0x86, 0x80)));
			break;
		case ZR::EProp::Rhino:
			AddBeast(B, Foot, Yaw, 3.6 * M, 1.7 * M, 1.7 * M, 1.0 * M, 0.2 * M, 1.2 * M,
				FLinearColor::FromSRGBColor(FColor(0x7A, 0x76, 0x72)));
			break;
		case ZR::EProp::Giraffe:
			AddBeast(B, Foot, Yaw, 2.6 * M, 1.8 * M, 1.3 * M, 2.6 * M, 2.6 * M, 0.9 * M,
				FLinearColor::FromSRGBColor(FColor(0xC9, 0x9A, 0x54)));
			break;
		case ZR::EProp::Zebra:
			AddBeast(B, Foot, Yaw, 2.2 * M, 1.1 * M, 0.8 * M, 1.1 * M, 0.7 * M, 0.7 * M,
				FLinearColor::FromSRGBColor(FColor(0xEC, 0xE7, 0xDE)));
			break;
		case ZR::EProp::Antelope:
			AddBeast(B, Foot, Yaw, 1.6 * M, 0.8 * M, 0.6 * M, 0.9 * M, 0.5 * M, 0.5 * M,
				FLinearColor::FromSRGBColor(FColor(0xA9, 0x7B, 0x4C)));
			break;
		case ZR::EProp::Croc:
		{
			// Long, low, and lying right on the trail edge.
			const FQuat Q(FVector::UpVector, Yaw);
			const FLinearColor Hide = FLinearColor::FromSRGBColor(FColor(0x4A, 0x56, 0x3C));
			B.AddBlob(Foot + FVector(0, 0, 0.22 * S * M),
				FVector(1.6 * S * M, 0.45 * S * M, 0.22 * S * M), 3, 6, Hide);
			B.AddTaper(Foot + Q.RotateVector(FVector(1.5 * S * M, 0, 0)) + FVector(0, 0, 0.2 * S * M),
			           Foot + Q.RotateVector(FVector(2.6 * S * M, 0, 0)) + FVector(0, 0, 0.14 * S * M),
			           0.30 * S * M, 0.10 * S * M, 5, Hide);
			B.AddTaper(Foot + Q.RotateVector(FVector(-1.4 * S * M, 0, 0)) + FVector(0, 0, 0.2 * S * M),
			           Foot + Q.RotateVector(FVector(-3.0 * S * M, 0, 0)) + FVector(0, 0, 0.08 * S * M),
			           0.28 * S * M, 0.05 * S * M, 5, Hide);
			break;
		}
		}
	}
}
