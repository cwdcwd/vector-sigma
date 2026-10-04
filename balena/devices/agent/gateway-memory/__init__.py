"""gateway-memory plugin — registration."""

from pathlib import Path

from . import schemas, tools


def register(ctx):
    ctx.register_tool(
        name="memory_get",
        toolset="memory",
        schema=schemas.MEMORY_GET,
        handler=tools.memory_get,
    )
    ctx.register_tool(
        name="memory_set",
        toolset="memory",
        schema=schemas.MEMORY_SET,
        handler=tools.memory_set,
    )
    ctx.register_tool(
        name="memory_list",
        toolset="memory",
        schema=schemas.MEMORY_LIST,
        handler=tools.memory_list,
    )

    skills_dir = Path(__file__).parent / "skills"
    for child in sorted(skills_dir.iterdir()):
        skill_md = child / "SKILL.md"
        if child.is_dir() and skill_md.exists():
            ctx.register_skill(child.name, skill_md)