#include "ZRPropField.h"

#include "Components/InstancedStaticMeshComponent.h"
#include "Core/ZRCore.h"
#include "Engine/StaticMesh.h"
#include "Game/ZRConvert.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"
#include "ProceduralMeshComponent.h"
#include "World/ZRMeshBuilder.h"
#include "World/ZRPropGeometry.h"

namespace
{
	/** Props are merged per (type, 120 m band) so the hillside still culls.
	 *  One merged mesh for the whole 1.25 km track would have a bounding box
	 *  the size of the track and would never be rejected by the frustum or by
	 *  a shadow cascade. */
	constexpr double BandMetres = 120.0;
}

AZRPropField::AZRPropField()
{
	PrimaryActorTick.bCanEverTick = false;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
}

void AZRPropField::BuildFrom(const ZR::FWorld& World)
{
	if (!World.Def) return;

	Material = LoadObject<UMaterialInterface>(
		nullptr, TEXT("/Game/Materials/M_ZRVertexColor.M_ZRVertexColor"));

	const ZR::FTheme& Theme = World.Def->Theme;

	// ---- props, merged per type and band ----
	TMap<int32, FZRMeshBuf> Buckets;
	for (const ZR::FProp& P : World.Props)
	{
		const int32 Band = FMath::FloorToInt32(P.Z / BandMetres);
		const int32 Key = static_cast<int32>(P.Type) * 4096 + Band;
		ZRProp::Add(Buckets.FindOrAdd(Key), P, Theme);
	}

	// ---- checkpoint gates and the finish arch ----
	{
		const FLinearColor Accent = ZRConv::FromHexSRGB(Theme.Colour.Accent);
		const FLinearColor Flag = ZRConv::FromHexSRGB(0xFFF9EE);
		auto AddArch = [&](const ZR::FTrailPoint& T, bool bFinish)
		{
			const int32 Band = FMath::FloorToInt32(T.Z / BandMetres);
			FZRMeshBuf& B = Buckets.FindOrAdd(90000 + Band);
			const double M = ZRConv::MetresToUU;
			const FQuat Q(FVector::UpVector, ZRConv::YawDeg(T.Yaw) * PI / 180.0);
			const FLinearColor C = bFinish ? Flag : Accent;
			const double Half = 3.2 * M;
			const double H = (bFinish ? 4.2 : 3.4) * M;
			for (int32 Side = -1; Side <= 1; Side += 2)
			{
				const FVector Base = ZRConv::Pos(T.X, T.Y, T.Z)
					+ Q.RotateVector(FVector(0, Side * Half, 0));
				B.AddTaper(Base, Base + FVector(0, 0, H), 0.16 * M, 0.13 * M, 5, C);
			}
			const FVector Top = ZRConv::Pos(T.X, T.Y, T.Z) + FVector(0, 0, H);
			B.AddBox(Top, FVector(0.16 * M, Half, 0.22 * M),
				FRotator(0.0, ZRConv::YawDeg(T.Yaw), 0.0), C);
		};

		for (int32 GateIdx : World.Gates)
		{
			if (GateIdx >= 0 && GateIdx < World.TrailN) AddArch(World.Trail[GateIdx], false);
		}
		if (World.FinishIdx >= 0 && World.FinishIdx < World.TrailN)
		{
			AddArch(World.Trail[World.FinishIdx], true);
		}
	}

	for (const TPair<int32, FZRMeshBuf>& Pair : Buckets)
	{
		if (Pair.Value.IsEmpty()) continue;
		UProceduralMeshComponent* Mesh = NewObject<UProceduralMeshComponent>(this);
		Mesh->SetupAttachment(RootComponent);
		Mesh->bUseAsyncCooking = false;
		Mesh->RegisterComponent();
		Mesh->CreateMeshSection_LinearColor(0, Pair.Value.Verts, Pair.Value.Tris,
			Pair.Value.Normals, Pair.Value.UVs, Pair.Value.Colours,
			TArray<FProcMeshTangent>(), /*bCreateCollision=*/false);
		if (Material) Mesh->SetMaterial(0, Material);
		Mesh->SetCastShadow(true);
		Meshes.Add(Mesh);
	}

	// ---- coins: the one thing here that actually changes ----
	if (UStaticMesh* Disc = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cylinder.Cylinder")))
	{
		Coins = NewObject<UInstancedStaticMeshComponent>(this, TEXT("Coins"));
		Coins->SetStaticMesh(Disc);
		Coins->SetupAttachment(RootComponent);
		Coins->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		Coins->SetCastShadow(false);
		Coins->RegisterComponent();

		if (Material)
		{
			UMaterialInstanceDynamic* Gold = UMaterialInstanceDynamic::Create(Material, this);
			Gold->SetVectorParameterValue(TEXT("Tint"), ZRConv::FromHexSRGB(0xF7B733));
			Gold->SetScalarParameterValue(TEXT("Roughness"), 0.25f);
			Gold->SetScalarParameterValue(TEXT("Metallic"), 0.9f);
			Coins->SetMaterial(0, Gold);
		}

		CoinTransforms.Reserve(World.Coins.size());
		for (const ZR::FCoin& C : World.Coins)
		{
			// A coin lying face-on to the rider, who is travelling along +X.
			const FTransform T(FRotator(0.0, 0.0, 90.0), ZRConv::Pos(C.X, C.Y, C.Z),
				FVector(0.36f, 0.36f, 0.05f));
			CoinTransforms.Add(T);
			Coins->AddInstance(T, /*bWorldSpace=*/true);
		}
	}

	UE_LOG(LogTemp, Log, TEXT("ZRPropField: %d props in %d merged meshes, %d coins."),
		static_cast<int32>(World.Props.size()), Meshes.Num(), CoinTransforms.Num());
}

void AZRPropField::HideCoin(int32 CoinIndex)
{
	if (!Coins || !CoinTransforms.IsValidIndex(CoinIndex)) return;
	FTransform Gone = CoinTransforms[CoinIndex];
	Gone.SetScale3D(FVector::ZeroVector);
	Coins->UpdateInstanceTransform(CoinIndex, Gone, /*bWorldSpace=*/true, /*bMarkRenderStateDirty=*/true);
}
