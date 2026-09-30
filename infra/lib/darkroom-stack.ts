import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib'
import * as s3 from 'aws-cdk-lib/aws-s3'
import { Construct } from 'constructs'

export class DarkroomStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

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
