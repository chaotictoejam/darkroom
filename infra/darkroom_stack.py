from aws_cdk import (
    CfnOutput,
    Duration,
    Stack,
    aws_iam as iam,
    aws_lambda as lambda_,
)
from constructs import Construct


class DarkroomStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        edl_fn = lambda_.Function(
            self,
            "EdlFunction",
            runtime=lambda_.Runtime.PYTHON_3_12,
            handler="handler.handler",
            code=lambda_.Code.from_asset("lambda"),
            timeout=Duration.minutes(5),
            memory_size=512,
            environment={
                "BEDROCK_MODEL_ID": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
            },
        )

        edl_fn.add_to_role_policy(
            iam.PolicyStatement(
                actions=["bedrock:InvokeModel"],
                resources=[
                    f"arn:aws:bedrock:{self.region}::foundation-model/"
                    "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
                ],
            )
        )

        # IAM-authenticated Function URL — callers need lambda:InvokeFunctionUrl
        fn_url = edl_fn.add_function_url(
            auth_type=lambda_.FunctionUrlAuthType.AWS_IAM,
        )

        CfnOutput(self, "EdlFunctionArn", value=edl_fn.function_arn)
        CfnOutput(self, "EdlFunctionUrl", value=fn_url.url)
