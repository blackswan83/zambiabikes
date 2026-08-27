#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "ZRTerrainActor.generated.h"

namespace ZR { struct FWorld; }
class UProceduralMeshComponent;

/**
 * Turns ZRCore's heightfield into geometry.
 *
 * The mesh is built once at BeginPlay and never changes. It carries NO
 * collision: the rider does its own terrain contact through ZR::HeightAt, so
 * cooking Chaos collision for ~83k triangles would cost a multi-second hitch
 * on the game thread and buy nothing.
 *
 * Terrain colour is baked into vertex colours from trail distance and slope,
 * which is what lets the whole game run off one generated material.
 */
UCLASS()
class AZRTerrainActor : public AActor
{
	GENERATED_BODY()

public:
	AZRTerrainActor();

	/** Builds the mesh. Call once, before the rider starts moving. */
	void BuildFrom(const ZR::FWorld& World);

private:
	/** One component per chunk of rows, so the hillside frustum-culls and the
	 *  shadow cascades can reject most of a 1.4 km mesh. A single component
	 *  with many sections would not: sections share the component's bounds. */
	UPROPERTY()
	TArray<TObjectPtr<UProceduralMeshComponent>> Chunks;

	UPROPERTY()
	TObjectPtr<class UMaterialInterface> TerrainMaterial;
};
