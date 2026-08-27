"""
gen_assets.py - generates the only binary asset Zambia Rush needs.

Run once, from the repository, with the editor in commandlet mode:

    "$UE/Engine/Binaries/Mac/UnrealEditor-Cmd" \
        /abs/path/to/unreal/ZambiaRush/ZambiaRush.uproject \
        -run=pythonscript -script="/abs/path/to/unreal/ZambiaRush/Tools/gen_assets.py" \
        -unattended -nosplash

Content/ is gitignored, so this is how a fresh clone gets its assets. The
project's Editor target must be built first - a commandlet cannot run against
C++ that has not compiled.

WHY THIS EXISTS AT ALL
----------------------
Everything else in this project is text. The map is the engine's own
/Engine/Maps/Entry; input needs no assets because AZRPlayerController reads
keys directly. But terrain colour is baked into vertex colours, and NO shipped
engine material reads vertex colour in a lit pass. Nor can one be made at
runtime: material shader compilation is editor-only, and a
UMaterialInstanceDynamic can set parameters but cannot add a VertexColor node.

So: one material, generated from code, checked by a human once.

WHY PYTHON AND NOT A C++ COMMANDLET
-----------------------------------
UPackage::SavePackage's signature has changed across UE5 minor versions and
the old overload was removed in 5.1. The Python wrappers have been stable
throughout. It also avoids adding a second editor module to the .uproject.
"""

import unreal

PACKAGE_PATH = "/Game/Materials"

_tools = unreal.AssetToolsHelpers.get_asset_tools()
_mel = unreal.MaterialEditingLibrary


def _fresh_material(name):
    """Creates PACKAGE_PATH/name, replacing any previous version."""
    full = "{}/{}".format(PACKAGE_PATH, name)
    if unreal.EditorAssetLibrary.does_asset_exist(full):
        unreal.log("gen_assets: replacing existing {}".format(full))
        unreal.EditorAssetLibrary.delete_asset(full)
    mat = _tools.create_asset(name, PACKAGE_PATH, unreal.Material,
                              unreal.MaterialFactoryNew())
    if mat is None:
        raise RuntimeError("could not create material {}".format(full))
    return mat


def _tinted_vertex_colour(mat, default_roughness):
    """VertexColor * Tint -> BaseColor, plus Roughness and Metallic params.

    One material serves the whole game. The terrain leaves Tint white and
    relies on its baked vertex colours; the bike, props, coins and gates have
    white vertex colours from the engine primitives and are tinted by a MID.
    """
    vertex = _mel.create_material_expression(
        mat, unreal.MaterialExpressionVertexColor, -600, 0)

    tint = _mel.create_material_expression(
        mat, unreal.MaterialExpressionVectorParameter, -600, 200)
    tint.set_editor_property("parameter_name", "Tint")
    tint.set_editor_property("default_value", unreal.LinearColor(1.0, 1.0, 1.0, 1.0))

    mul = _mel.create_material_expression(
        mat, unreal.MaterialExpressionMultiply, -320, 60)
    _mel.connect_material_expressions(vertex, "RGB", mul, "A")
    _mel.connect_material_expressions(tint, "", mul, "B")
    _mel.connect_material_property(mul, "", unreal.MaterialProperty.MP_BASE_COLOR)

    rough = _mel.create_material_expression(
        mat, unreal.MaterialExpressionScalarParameter, -320, 260)
    rough.set_editor_property("parameter_name", "Roughness")
    rough.set_editor_property("default_value", default_roughness)
    _mel.connect_material_property(rough, "", unreal.MaterialProperty.MP_ROUGHNESS)

    metal = _mel.create_material_expression(
        mat, unreal.MaterialExpressionScalarParameter, -320, 360)
    metal.set_editor_property("parameter_name", "Metallic")
    metal.set_editor_property("default_value", 0.0)
    _mel.connect_material_property(metal, "", unreal.MaterialProperty.MP_METALLIC)

    return tint


def build_opaque():
    mat = _fresh_material("M_ZRVertexColor")
    mat.set_editor_property("two_sided", False)
    _tinted_vertex_colour(mat, 0.75)
    _mel.recompile_material(mat)
    unreal.EditorAssetLibrary.save_loaded_asset(mat)
    unreal.log("gen_assets: wrote {}/M_ZRVertexColor".format(PACKAGE_PATH))


def build_ghost():
    """Translucent twin, for Armand's and Arthur's ghosts."""
    mat = _fresh_material("M_ZRGhost")
    mat.set_editor_property("blend_mode", unreal.BlendMode.BLEND_TRANSLUCENT)
    mat.set_editor_property("shading_model", unreal.MaterialShadingModel.MSM_UNLIT)
    mat.set_editor_property("two_sided", True)

    vertex = _mel.create_material_expression(
        mat, unreal.MaterialExpressionVertexColor, -600, 0)
    tint = _mel.create_material_expression(
        mat, unreal.MaterialExpressionVectorParameter, -600, 200)
    tint.set_editor_property("parameter_name", "Tint")
    tint.set_editor_property("default_value", unreal.LinearColor(1.0, 1.0, 1.0, 1.0))

    mul = _mel.create_material_expression(
        mat, unreal.MaterialExpressionMultiply, -320, 60)
    _mel.connect_material_expressions(vertex, "RGB", mul, "A")
    _mel.connect_material_expressions(tint, "", mul, "B")
    _mel.connect_material_property(mul, "", unreal.MaterialProperty.MP_EMISSIVE_COLOR)

    # 0.45 while the ghost is still riding; the game drops it to 0.18 once it
    # finishes, the same way the browser game fades a spent ghost.
    opacity = _mel.create_material_expression(
        mat, unreal.MaterialExpressionScalarParameter, -320, 260)
    opacity.set_editor_property("parameter_name", "Opacity")
    opacity.set_editor_property("default_value", 0.45)
    _mel.connect_material_property(opacity, "", unreal.MaterialProperty.MP_OPACITY)

    _mel.recompile_material(mat)
    unreal.EditorAssetLibrary.save_loaded_asset(mat)
    unreal.log("gen_assets: wrote {}/M_ZRGhost".format(PACKAGE_PATH))


def main():
    if not unreal.EditorAssetLibrary.does_directory_exist(PACKAGE_PATH):
        unreal.EditorAssetLibrary.make_directory(PACKAGE_PATH)
    build_opaque()
    build_ghost()
    unreal.log("gen_assets: done. Both materials are in Content/Materials.")


main()
