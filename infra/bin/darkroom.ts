#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib'
import { DarkroomStack } from '../lib/darkroom-stack'

const app = new cdk.App()
new DarkroomStack(app, 'DarkroomStack')
