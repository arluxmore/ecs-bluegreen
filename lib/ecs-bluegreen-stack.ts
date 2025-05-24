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

export class EcsBlueGreenStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const region = Stack.of(this).region;
    const account = Stack.of(this).account;
    
    const allowedIp = this.node.tryGetContext('allowedIp') ?? '0.0.0.0/0';
    const imageTag = this.node.tryGetContext('imageTag');

    if (imageTag === undefined) {
      throw new Error('image tag required - use nginx for first deploy');
    }

    const vpc = new ec2.Vpc(this, 'Vpc', { maxAzs: 2 });

    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });
    
    const repo = new ecr.Repository(this, 'AppRepo', {
      repositoryName
    });

    const taskDef = {
      cpu: 256,
      memoryLimitMiB: 512,
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

    if (imageTag === 'nginx') {
      blueTaskDef.addContainer('BlueApp', {
        portMappings: [{ containerPort: 80 }],
        image: ecs.ContainerImage.fromRegistry('nginx:alpine'),
      });
    } else {
      blueTaskDef.addContainer('BlueApp', {
        portMappings: [{ containerPort: 80 }],
        image: ecs.ContainerImage.fromRegistry(`${account}.dkr.ecr.${region}.amazonaws.com/${repositoryName}:${imageTag}`),
      });
    }

    greenTaskDef.addContainer('GreenApp', {
      containerName: 'App',
      portMappings: [{ containerPort: 80 }],
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
      port: 80,
      open: true,
    };

    const blueListener = blueLb.addListener('BlueHttpListener', listener);

    const greenListener = greenLb.addListener('GreenHttpListener', listener);

    // Target Groups
    const targetGroup = {
      vpc,
      port: 80,
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
    const project = new codebuild.PipelineProject(this, 'GreenBuildProject', {
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
              'export IMAGE_TAG=${CODEBUILD_RESOLVED_SOURCE_VERSION:0:7}',
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
              'echo Writing taskdef.json...',
              'cat > taskdef.json <<EOF',
              '{',
              '  "family": "your-task-family",',
              '  "containerDefinitions": [',
              '    {',
              '      "name": "web",',
              '      "image": "' + '$REPOSITORY_URI:$IMAGE_TAG' + '",',
              '      "memory": 512,',
              '      "cpu": 256,',
              '      "essential": true,',
              '      "portMappings": [',
              '        { "containerPort": 80, "protocol": "tcp" }',
              '      ]',
              '    }',
              '  ]',
              '}',
              'EOF',
              'echo Writing appspec.yaml...',
              'cat > appspec.yaml <<EOF',
              'version: 1',
              'Resources:',
              '  - TargetService:',
              '      Type: AWS::ECS::Service',
              '      Properties:',
              '        TaskDefinition: "taskdef.json"',
              '        LoadBalancerInfo:',
              '          ContainerName: "web"',
              '          ContainerPort: 80',
              'EOF',
            ],
          },
        },
        artifacts: {
          files: ['taskdef.json', 'appspec.yaml'],
        },
      }),
    });


    repo.grantPullPush(project.role!);

    const sourceOutput = new codepipeline.Artifact();
    const buildOutput = new codepipeline.Artifact();

    const pipeline = new codepipeline.Pipeline(this, 'GreenPipeline', {
      pipelineName: 'GreenDeployPipeline',
    });

    pipeline.addStage({
      stageName: 'Source',
      actions: [
        new codepipeline_actions.GitHubSourceAction({
          actionName: 'GitHub_Source',
          oauthToken: SecretValue.secretsManager('github-token'),
          owner: gitHubOwner,
          repo: repositoryName,
          output: sourceOutput,
          branch: 'main',
        }),
      ],
    });

    pipeline.addStage({
      stageName: 'BuildAndPush',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'Build_and_Push_Image',
          project,
          input: sourceOutput,
          outputs: [buildOutput],
        }),
      ],
    });

    pipeline.addStage({
      stageName: 'DeployGreen',
      actions: [
        new codepipeline_actions.EcsDeployAction({
          actionName: 'DeployToGreen',
          service: greenService,
          input: buildOutput,
        }),
      ],
    });

    pipeline.addStage({
      stageName: 'DeployBlue',
      actions: [
        new codepipeline_actions.CodeDeployEcsDeployAction({
          actionName: 'DeployToBlue',
          deploymentGroup: blueDeploymentGroup,
          taskDefinitionTemplateInput: buildOutput,
          appSpecTemplateInput: buildOutput,
        }),
      ],
    });
  }
}
