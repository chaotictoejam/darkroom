import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as s3 from 'aws-cdk-lib/aws-s3'
import { Construct } from 'constructs'

export class DarkroomStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    // ── Bedrock EDL Lambda ────────────────────────────────────────────────
    // Thin async orchestration function — only calls boto3 APIs already
    // present in the Lambda runtime, so this stays a plain asset (no Docker
    // bundling required to synth or deploy).
    const edlFn = new lambda.Function(this, 'EdlFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset('lambda'),
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: {
        BEDROCK_MODEL_ID: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      },
    })

    edlFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/` +
            'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        ],
      }),
    )

    // IAM-authenticated Function URL — callers need lambda:InvokeFunctionUrl
    const edlFnUrl = edlFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    })

    new CfnOutput(this, 'EdlFunctionArn', { value: edlFn.functionArn })
    new CfnOutput(this, 'EdlFunctionUrl', { value: edlFnUrl.url })

    // ── Amazon Transcribe scratch bucket ────────────────────────────────────
    // Holds audio uploaded for cloud transcription and the resulting
    // transcript JSON when a project's TRANSCRIBE_PROVIDER=aws. Darkroom's
    // backend deletes each object itself right after the job completes —
    // this lifecycle rule is just a backstop against orphaned objects.
    const transcribeBucket = new s3.Bucket(this, 'TranscribeBucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{ expiration: Duration.days(1) }],
    })

    new CfnOutput(this, 'TranscribeBucketName', { value: transcribeBucket.bucketName })
  }
}
