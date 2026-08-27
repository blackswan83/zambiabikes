#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "ZRPropField.generated.h"

namespace ZR { struct FWorld; }
class UProceduralMeshComponent;
class UInstancedStaticMeshComponent;

/**
 * Every tree, rock, animal, checkpoint gate and coin on the hill.
 *
 * Props are static for the whole run, so rather than instancing them we bake
 * all instances of a type into one merged mesh in world space: ~1,650 props
 * become about a dozen draw calls with no per-instance bookkeeping, and no
 * UStaticMesh assets to author. Coins do change (they get collected), so they
 * are the one thing here that is genuinely instanced.
 *
 * Placement, scale, rotation and collision radius all come from ZRCore. This
 * actor never decides where anything goes — if it did, the props would stop
 * matching the collision bodies the AI ghosts were recorded against.
 */
UCLASS()
class AZRPropField : public AActor
{
	GENERATED_BODY()

public:
	AZRPropField();

	void BuildFrom(const ZR::FWorld& World);

	/** Sinks a collected coin out of sight. Index is into World.Coins. */
	void HideCoin(int32 CoinIndex);

private:
	UPROPERTY() TArray<TObjectPtr<UProceduralMeshComponent>> Meshes;
	UPROPERTY() TObjectPtr<UInstancedStaticMeshComponent> Coins;
	UPROPERTY() TObjectPtr<class UMaterialInterface> Material;

	TArray<FTransform> CoinTransforms;
};
