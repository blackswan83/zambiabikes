#pragma once

#include "CoreMinimal.h"
#include "Components/SceneComponent.h"
#include "ZRBikeRig.generated.h"

class UStaticMeshComponent;
class UMaterialInstanceDynamic;

/**
 * A rider on a bike, built from engine primitives at runtime.
 *
 * The browser game draws a far more detailed rig (js/game3d.js, and the Garage
 * models all 58 components as real geometry). This is the vertical slice's
 * stand-in: the right silhouette, the right proportions, cranks that turn with
 * the wheels. Porting the detailed geometry is a later milestone and does not
 * change anything below the visuals.
 *
 * Nothing here feeds back into the simulation. It is told where the bike is
 * and draws it.
 */
UCLASS()
class UZRBikeRig : public USceneComponent
{
	GENERATED_BODY()

public:
	UZRBikeRig();

	/** Creates the mesh components. Call once after registration.
	 *  @param bGhost use the translucent ghost material instead of the opaque one. */
	void Build(const FLinearColor& JerseyColour, bool bGhost = false);

	/**
	 * @param WheelSpin  ZRCore's accumulated wheel angle, radians
	 * @param Lean       ZRCore's lean, -1..1
	 * @param Pitch      trick flip angle, radians
	 * @param bPedalling whether the legs should be driving
	 */
	void Pose(double WheelSpin, double Lean, double Pitch, bool bPedalling);

private:
	UStaticMeshComponent* AddPiece(const TCHAR* ShapePath, const TCHAR* Name,
		const FVector& RelLocationCm, const FRotator& RelRotation,
		const FVector& ScaleCm, const FLinearColor& Colour, bool bGhost);

	UPROPERTY() TObjectPtr<UStaticMeshComponent> FrontWheel;
	UPROPERTY() TObjectPtr<UStaticMeshComponent> RearWheel;
	UPROPERTY() TObjectPtr<UStaticMeshComponent> Crank;
	UPROPERTY() TObjectPtr<UStaticMeshComponent> Torso;
	UPROPERTY() TObjectPtr<UStaticMeshComponent> LegL;
	UPROPERTY() TObjectPtr<UStaticMeshComponent> LegR;
	UPROPERTY() TObjectPtr<USceneComponent> Body;

	UPROPERTY() TArray<TObjectPtr<UMaterialInstanceDynamic>> Materials;
};
