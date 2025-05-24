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

const repositoryName = 'sample-container-app';
const gitHubOwner = 'arluxmore';

export class EcsBlueGreenStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const region = Stack.of(this).region;
    const account = Stack.of(this).account;
    
    const allowedIp = this.node.tryGetContext('allowedIp') ?? '0.0.0.0/0';
    const imageTag = this.node.tryGetContext('imageTag');
    const excludeGreen = !!this.node.tryGetContext('excludeGreen');

    if (imageTag === undefined) {
      throw new Error('image tag required - use nginx for first deploy');
    }

    const vpc = new ec2.Vpc(this, 'Vpc', { maxAzs: 2 });

    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });
    
    const repo = new ecr.Repository(this, 'AppRepo');

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

    // Task Definition (Blue - Nginx)
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
      image: ecs.ContainerImage.fromRegistry('nginx:alpine'),
      portMappings: [],
    });

    // Proxy container
    greenTaskDef.addContainer('Proxy', {
      image: ecs.ContainerImage.fromAsset('./proxy'),
      portMappings: [{ containerPort: 80 }],
      essential: true,
    });

    // Fargate Service (Blue)
    const blueService = new ecs.FargateService(this, 'BlueService', {
      cluster,
      taskDefinition: blueTaskDef,
      desiredCount: 1,
      assignPublicIp: true,
    });

    const lb = new elbv2.ApplicationLoadBalancer(this, 'LB', {
      vpc,
      internetFacing: true,
    });

    const listener = lb.addListener('HttpListener', {
      port: 80,
      open: true,
    });

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

    listener.addTargetGroups('DefaultRule', {
      targetGroups: [blueTG],
    });

    listener.addTargetGroups('GreenRule', {
      priority: 10, // must be unique and > 1 (default has lowest priority)
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/green/*']),
        elbv2.ListenerCondition.sourceIps([allowedIp]),
      ],
      targetGroups: [greenTG],
    });

    blueService.attachToApplicationTargetGroup(blueTG);

    


    // CodeBuild Project
    const project = new codebuild.PipelineProject(this, 'GreenBuildProject', {
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true, // required for Docker
      },
      environmentVariables: {
        REPOSITORY_URI: { value: repo.repositoryUri },
        IMAGE_TAG: { value: 'latest' }, // default fallback
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo Logging in to Amazon ECR...',
              'aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $REPOSITORY_URI',
              'export IMAGE_TAG=$CODEBUILD_RESOLVED_SOURCE_VERSION',
            ],
          },
          build: {
            commands: [
              'echo Building the Docker image...',
              'docker build -t $REPOSITORY_URI:$IMAGE_TAG .',
              'docker push $REPOSITORY_URI:$IMAGE_TAG',
            ],
          },
          post_build: {
            commands: [
              'echo Writing imagedefinitions.json...',
              'printf \'[{"name":"App","imageUri":"%s"}]\' "$REPOSITORY_URI:$IMAGE_TAG" > imagedefinitions.json',
            ],
          },
        },
        artifacts: {
          files: ['imagedefinitions.json'],
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

    // if green service changes after initial deployment,
    // it must be deleted with excludeGreen then recreated
    if (!excludeGreen) {
      const greenService = new ecs.FargateService(this, 'GreenService', {
        cluster,
        taskDefinition: greenTaskDef,
        desiredCount: 1,
        assignPublicIp: true,
        deploymentController: {
          type: ecs.DeploymentControllerType.CODE_DEPLOY,
        },
      });

      
      greenService.attachToApplicationTargetGroup(greenTG);

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
    }
  }
}
