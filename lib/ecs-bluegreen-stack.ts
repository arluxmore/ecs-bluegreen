import { Stack, StackProps, SecretValue } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';

const repositoryName = 'sample-container-app';
const gitHubOwner = 'arluxmore';

const cpu = 256;
const memory = 512;
const containerPort = 80;

export class EcsBlueGreenStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const region = Stack.of(this).region;
    const account = Stack.of(this).account;
    
    const allowedIp = this.node.tryGetContext('allowedIp') ?? '0.0.0.0/0';

    const vpc = new ec2.Vpc(this, 'Vpc', { maxAzs: 2 });

    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });
    
    const repo = new ecr.Repository(this, 'AppRepo', {
      repositoryName
    });

    const taskDef = {
      cpu,
      memoryLimitMiB: memory,
      executionRole: new iam.Role(this, 'FargateExecutionRole', {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
        ],
      }),
    };

    // Task Definition 
    const blueTaskDef = new ecs.FargateTaskDefinition(this, 'BlueTaskDef', taskDef);
    const greenTaskDef = new ecs.FargateTaskDefinition(this, 'GreenTaskDef', taskDef);    

    blueTaskDef.addContainer('BlueApp', {
      portMappings: [{ containerPort }],
      image: ecs.ContainerImage.fromRegistry('nginx:alpine'),
    });

    greenTaskDef.addContainer('GreenApp', {
      containerName: 'App',
      portMappings: [{ containerPort }],
      image: ecs.ContainerImage.fromRegistry('nginx:alpine'),
    });


    // Fargate Service
    const blueService = new ecs.FargateService(this, 'BlueService', {
      cluster,
      desiredCount: 1,
      assignPublicIp: true,
      taskDefinition: blueTaskDef,
      deploymentController: {
        type: ecs.DeploymentControllerType.CODE_DEPLOY,
      },
    });
    
    const greenService = new ecs.FargateService(this, 'GreenService', {
      cluster,
      desiredCount: 1,
      assignPublicIp: true,
      taskDefinition: greenTaskDef
    });

    const lb = {
      vpc,
      internetFacing: true,
    };

    const blueLb = new elbv2.ApplicationLoadBalancer(this, 'BlueLB', lb);

    const greenLb = new elbv2.ApplicationLoadBalancer(this, 'GreenLB', lb);

    const listener = {
      port: containerPort,
      open: true,
    };

    const blueListener = blueLb.addListener('BlueHttpListener', listener);

    const greenListener = greenLb.addListener('GreenHttpListener', listener);

    // Target Groups
    const targetGroup = {
      vpc,
      port: containerPort,
      targetType: elbv2.TargetType.IP,
      protocol: elbv2.ApplicationProtocol.HTTP,
      healthCheck: { path: '/' },
    };

    const blueTG = new elbv2.ApplicationTargetGroup(this, 'BlueTG', targetGroup);
    const greenTG = new elbv2.ApplicationTargetGroup(this, 'GreenTG', targetGroup);
    const greenTargetGroupForBlue = new elbv2.ApplicationTargetGroup(this, 'BlueGreenTG', targetGroup);

    blueListener.addTargetGroups('DefaultRule', {
      targetGroups: [blueTG],
    });

    greenListener.addTargetGroups('GreenRule', {
      priority: 10,
      conditions: [
        elbv2.ListenerCondition.sourceIps([allowedIp]),
      ],
      targetGroups: [greenTG],
    });

    // Default action: deny all others
    greenListener.addAction('DefaultDeny', {
      action: elbv2.ListenerAction.fixedResponse(403, {
        contentType: 'text/plain',
        messageBody: 'Access denied',
      }),
    });

    blueService.attachToApplicationTargetGroup(blueTG);
    greenService.attachToApplicationTargetGroup(greenTG);

    const blueApp = new codedeploy.EcsApplication(this, 'BlueApp');

    const blueDeploymentGroup = new codedeploy.EcsDeploymentGroup(this, 'BlueDG', {
      application: blueApp,
      service: blueService,
      blueGreenDeploymentConfig: {
        blueTargetGroup: blueTG,
        greenTargetGroup: greenTargetGroupForBlue,
        listener: blueListener, // ALB listener that receives production traffic
      },
      deploymentConfig: codedeploy.EcsDeploymentConfig.ALL_AT_ONCE, // or LINEAR, etc.
      autoRollback: {
        failedDeployment: true,
      },
    });


    // CodeBuild Project
    const greenBuildProject = new codebuild.PipelineProject(this, 'GreenBuildProject', {
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true, // required for Docker
      },
      environmentVariables: {
        REPOSITORY_URI: { value: repo.repositoryUri },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo Logging in to Amazon ECR...',
              'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $REPOSITORY_URI',
              'export IMAGE_TAG=$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c1-7)',
              'echo "Image tag used: $IMAGE_TAG"',
            ],
          },
          build: {
            commands: [
              'echo Building Docker image...',
              'docker build -t $REPOSITORY_URI:$IMAGE_TAG .',
              'docker push $REPOSITORY_URI:$IMAGE_TAG',
            ],
          },
          post_build: {
            commands: [
              'echo "Generating imagedefinitions.json..."',
              [
                'cat > imagedefinitions.json <<EOF',
                '[',
                '  {',
                '    "name": "App",',
                '    "imageUri": "$REPOSITORY_URI:$IMAGE_TAG"',
                '  }',
                ']',
                'EOF'
              ].join('\n'),
            ],
          },
        },
        artifacts: {
          files: ['imagedefinitions.json'],
        },
      }),
    });

    const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    const blueBuildProject = new codebuild.PipelineProject(this, 'BlueBuildProject', {
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true,
      },
      environmentVariables: {
        TASK_FAMILY: { value: blueTaskDef.family },
        REPOSITORY_URI: { value: repo.repositoryUri },
        MEMORY: { value: memory },
        CPU: { value: cpu },
        PORT: { value: containerPort },
        EXECUTION_ROLE_ARN: { value: taskExecutionRole.roleArn },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo Logging in to Amazon ECR...',
              'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $REPOSITORY_URI',
              'IMAGE_TAG=$(aws ssm get-parameter --name /promote/imageTag --query Parameter.Value --output text)',
              'echo Promoting image $IMAGE_TAG',
            ],
          },
          build: {
            commands: [
              'docker pull $REPOSITORY_URI:$IMAGE_TAG',
              // skip push, reuse image
            ],
          },
          post_build: {
            commands: [
              'echo Writing taskdef.json...',
              [
                'cat > taskdef.json <<EOF',
                '{',
                '  "family": "$TASK_FAMILY",',
                '  "networkMode": "awsvpc",',
                '  "executionRoleArn": "$EXECUTION_ROLE_ARN",',
                '  "containerDefinitions": [',
                '    {',
                '      "name": "web",',
                '      "image": "$REPOSITORY_URI:$IMAGE_TAG",',
                '      "memory": $MEMORY,',
                '      "cpu": $CPU,',
                '      "essential": true,',
                '      "portMappings": [',
                '        {',
                '          "containerPort": $PORT,',
                '          "protocol": "tcp"',
                '        }',
                '      ]',
                '    }',
                '  ]',
                '}',
                'EOF',
              ].join('\n'),

              'echo Writing appspec.yaml...',
              [
                'cat > appspec.yaml <<EOF',
                'version: 1',
                'Resources:',
                '  - TargetService:',
                '      Type: AWS::ECS::Service',
                '      Properties:',
                '        TaskDefinition: <TASK_DEFINITION>',
                '        LoadBalancerInfo:',
                '          ContainerName: "web"',
                '          ContainerPort: $PORT',
                'EOF',
              ].join('\n'),
            ],
          }
        },
        artifacts: {
          files: ['taskdef.json', 'appspec.yaml'],
        },
      }),
    });

    repo.grantPullPush(greenBuildProject.role!);
    repo.grantPullPush(blueBuildProject.role!);

    blueBuildProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${region}:${account}:parameter/promote/imageTag`],
    }));


    const greenPipeline = new codepipeline.Pipeline(this, 'GreenDeployPipeline', {
      pipelineName: 'GreenDeployPipeline',
    });

    const bluePipeline = new codepipeline.Pipeline(this, 'BlueDeployPipeline', {
      pipelineName: 'BlueDeployPipeline',
    });

    

    const greenSourceOutput = new codepipeline.Artifact();
    const greenBuildOutput = new codepipeline.Artifact();


    greenPipeline.addStage({
      stageName: 'Source',
      actions: [
        new codepipeline_actions.GitHubSourceAction({
          actionName: 'GitHub_Source',
          oauthToken: SecretValue.secretsManager('github-token'),
          owner: gitHubOwner,
          repo: repositoryName,
          output: greenSourceOutput,
          branch: 'main',
        }),
      ],
    });

    greenPipeline.addStage({
      stageName: 'BuildAndPush',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'Build_and_Push_Image',
          project: greenBuildProject,
          input: greenSourceOutput,
          outputs: [greenBuildOutput],
        }),
      ],
    });

    greenPipeline.addStage({
      stageName: 'DeployGreen',
      actions: [
        new codepipeline_actions.EcsDeployAction({
          actionName: 'DeployToGreen',
          service: greenService,
          input: greenBuildOutput,
        }),
      ],
    });

    const blueSourceOutput = new codepipeline.Artifact();
    const blueBuildOutput = new codepipeline.Artifact();

    bluePipeline.addStage({
      stageName: 'Source',
      actions: [
        new codepipeline_actions.GitHubSourceAction({
          actionName: 'GitHub_Source',
          oauthToken: SecretValue.secretsManager('github-token'),
          owner: gitHubOwner,
          repo: repositoryName,
          branch: 'main',
          output: blueSourceOutput,
          trigger: codepipeline_actions.GitHubTrigger.NONE, 
        }),
      ],
    });

    bluePipeline.addStage({
      stageName: 'BuildBlue',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'BuildArtifactsForBlue',
          project: blueBuildProject,
          input: blueSourceOutput,
          outputs: [blueBuildOutput],
        }),
      ],
    });


    bluePipeline.addStage({
      stageName: 'DeployBlue',
      actions: [
        new codepipeline_actions.CodeDeployEcsDeployAction({
          actionName: 'DeployToBlue',
          deploymentGroup: blueDeploymentGroup,
          taskDefinitionTemplateFile: blueBuildOutput.atPath('taskdef.json'),
          appSpecTemplateFile: blueBuildOutput.atPath('appspec.yaml'),
        }),
      ],
    });
  }
}
