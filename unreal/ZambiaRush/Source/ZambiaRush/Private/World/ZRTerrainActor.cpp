#include "ZRTerrainActor.h"

#include "Core/ZRCore.h"
#include "Game/ZRConvert.h"
#include "HAL/IConsoleManager.h"
#include "Materials/MaterialInterface.h"
#include "ProceduralMeshComponent.h"
#include "UObject/ConstructorHelpers.h"

namespace
{
	/** Rows of the heightfield per chunk component. 32 gives ~10 chunks for
	 *  Miombo — enough for culling to matter, few enough that the draw call
	 *  count stays trivial. */
	constexpr int32 RowsPerChunk = 32;

	static TAutoConsoleVariable<int32> CVarFlipWinding(
		TEXT("zr.Terrain.FlipWinding"), 0,
		TEXT("Flip terrain triangle winding. If the hillside renders inside-out ")
		TEXT("or invisible from above, set this to 1 and rebuild the level. ")
		TEXT("Winding was derived rather than observed; this is the escape hatch."),
		ECVF_Default);

	/**
	 * The browser game paints terrain procedurally on a canvas from the track
	 * theme (js/game3d.js buildScene). We bake the same idea into vertex
	 * colours: dirt on the trail and its worn edges, grass off it, drying out
	 * on the flats, going to rock where it gets steep.
	 */
	FLinearColor GroundColour(const ZR::FTheme& Theme, double TrailDist, double SlopeY, double Height)
	{
		const FLinearColor Grass    = ZRConv::FromHexSRGB(Theme.Colour.Grass);
		const FLinearColor GrassDry = ZRConv::FromHexSRGB(Theme.Colour.GrassDry);
		const FLinearColor Dirt     = ZRConv::FromHexSRGB(Theme.Colour.Dirt);
		const FLinearColor DirtDark = ZRConv::FromHexSRGB(Theme.Colour.DirtDark);
		const FLinearColor Rock     = ZRConv::FromHexSRGB(Theme.Colour.Rock);

		// Steepness: SlopeY is the up-component of the surface normal, 1 on the
		// flat. Rock takes over on anything the rider could not ride anyway.
		const double Steep = FMath::Clamp((1.0 - SlopeY) / 0.45, 0.0, 1.0);

		// A slow height-driven dryness so the hillside is not one flat green.
		const double Dry = FMath::Clamp(0.35 + 0.02 * Height, 0.0, 1.0);

		FLinearColor Ground = FMath::Lerp(Grass, GrassDry, static_cast<float>(Dry));
		Ground = FMath::Lerp(Ground, Rock, static_cast<float>(Steep));

		// The trail itself: hard-packed dirt in the middle, darker in the ruts,
		// feathering out over the same radius ZRCore carves with.
		const double OnTrail = 1.0 - FMath::SmoothStep(
			2.2f, static_cast<float>(ZR::CARVE_R), static_cast<float>(TrailDist));
		const double Ruts = 1.0 - FMath::SmoothStep(0.0f, 1.6f, static_cast<float>(TrailDist));
		FLinearColor Track = FMath::Lerp(Dirt, DirtDark, static_cast<float>(Ruts * 0.75));

		return FMath::Lerp(Ground, Track, static_cast<float>(OnTrail));
	}
}

AZRTerrainActor::AZRTerrainActor()
{
	PrimaryActorTick.bCanEverTick = false;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
}

void AZRTerrainActor::BuildFrom(const ZR::FWorld& World)
{
	if (!World.Def || World.NX <= 1 || World.NZ <= 1)
	{
		UE_LOG(LogTemp, Error, TEXT("ZRTerrainActor: empty world, nothing to build."));
		return;
	}

	// One generated material for the whole game. See Tools/gen_assets.py —
	// no engine material reads vertex colour in a lit pass, so this is the
	// single asset the project cannot avoid.
	if (!TerrainMaterial)
	{
		TerrainMaterial = LoadObject<UMaterialInterface>(
			nullptr, TEXT("/Game/Materials/M_ZRVertexColor.M_ZRVertexColor"));
		if (!TerrainMaterial)
		{
			UE_LOG(LogTemp, Error,
				TEXT("ZRTerrainActor: /Game/Materials/M_ZRVertexColor is missing. ")
				TEXT("Run Tools/gen_assets.py — see docs/unreal-mac.md."));
		}
	}

	const ZR::FTheme& Theme = World.Def->Theme;
	const bool bFlip = CVarFlipWinding.GetValueOnGameThread() != 0;
	const int32 NX = World.NX;
	const int32 NZ = World.NZ;

	for (int32 ChunkStart = 0; ChunkStart < NZ - 1; ChunkStart += RowsPerChunk)
	{
		const int32 ChunkEnd = FMath::Min(ChunkStart + RowsPerChunk, NZ - 1);
		const int32 RowCount = ChunkEnd - ChunkStart + 1;   // inclusive of the seam row

		TArray<FVector> Verts;
		TArray<int32> Tris;
		TArray<FVector> Normals;
		TArray<FVector2D> UVs;
		TArray<FLinearColor> Colours;
		TArray<FProcMeshTangent> Tangents;

		Verts.Reserve(NX * RowCount);
		Normals.Reserve(NX * RowCount);
		UVs.Reserve(NX * RowCount);
		Colours.Reserve(NX * RowCount);
		Tris.Reserve((NX - 1) * (RowCount - 1) * 6);

		for (int32 R = 0; R < RowCount; R++)
		{
			const int32 GZ = ChunkStart + R;
			const double WZ = World.Z0 + GZ * World.Step;
			for (int32 GX = 0; GX < NX; GX++)
			{
				const double WX = World.X0 + GX * World.Step;
				const double H = World.H[static_cast<size_t>(GZ) * NX + GX];
				const double TD = World.TD[static_cast<size_t>(GZ) * NX + GX];

				Verts.Add(ZRConv::Pos(WX, H, WZ));

				const ZR::FNormal N = ZR::NormalAt(World, WX, WZ);
				Normals.Add(ZRConv::Dir(N));

				// One UV unit per 8 metres, for anything that later wants a
				// detail texture. Nothing uses it yet.
				UVs.Add(FVector2D(WX / 8.0, WZ / 8.0));

				Colours.Add(GroundColour(Theme, TD, N.Y, H));
			}
		}

		for (int32 R = 0; R < RowCount - 1; R++)
		{
			for (int32 GX = 0; GX < NX - 1; GX++)
			{
				const int32 A = R * NX + GX;            // (gx,   gz)
				const int32 B = A + 1;                  // (gx+1, gz)
				const int32 C = A + NX;                 // (gx,   gz+1)
				const int32 D = C + 1;                  // (gx+1, gz+1)

				// Derived from the ZRConv mapping: with X_ue = +z and
				// Y_ue = -x, the order (A,B,C) gives (B-A) x (C-A) = +Z, i.e.
				// upward-facing. If that turns out wrong on real hardware,
				// zr.Terrain.FlipWinding 1 swaps it without a rebuild.
				if (!bFlip)
				{
					Tris.Add(A); Tris.Add(B); Tris.Add(C);
					Tris.Add(B); Tris.Add(D); Tris.Add(C);
				}
				else
				{
					Tris.Add(A); Tris.Add(C); Tris.Add(B);
					Tris.Add(B); Tris.Add(C); Tris.Add(D);
				}
			}
		}

		UProceduralMeshComponent* Chunk = NewObject<UProceduralMeshComponent>(this);
		Chunk->SetupAttachment(RootComponent);
		Chunk->bUseAsyncCooking = false;
		Chunk->RegisterComponent();

		// bCreateCollision = false is deliberate. The rider never queries
		// Unreal collision — ZR::HeightAt is the ground truth, and it has to
		// be, because the AI ghosts were recorded against it.
		Chunk->CreateMeshSection_LinearColor(
			0, Verts, Tris, Normals, UVs, Colours, Tangents, /*bCreateCollision=*/false);

		if (TerrainMaterial)
		{
			Chunk->SetMaterial(0, TerrainMaterial);
		}
		Chunk->SetCastShadow(true);
		Chunks.Add(Chunk);
	}

	UE_LOG(LogTemp, Log, TEXT("ZRTerrainActor: %s built, %d chunks, %d x %d grid."),
		*FString(World.Def->Name.c_str()), Chunks.Num(), NX, NZ);
}
