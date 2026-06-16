#!/usr/bin/env python3
import aws_cdk as cdk
from darkroom_stack import DarkroomStack

app = cdk.App()
DarkroomStack(app, "DarkroomStack")
app.synth()
