#!/usr/bin/env python3
"""CDK entry point: the Darkroom stack, with cost allocation tags on every resource."""
import json

import aws_cdk as cdk
from darkroom_stack import DarkroomStack


def _cost_tags(app: cdk.App) -> dict[str, str]:
    """Project tag plus any extras from the `tags` context (cdk.json or `-c tags='{...}'`)."""
    extra = app.node.try_get_context("tags") or {}
    if isinstance(extra, str):
        extra = json.loads(extra)
    return {"Project": "Darkroom", **extra}


app = cdk.App()
for key, value in _cost_tags(app).items():
    cdk.Tags.of(app).add(key, str(value))
DarkroomStack(app, "DarkroomStack")
app.synth()
