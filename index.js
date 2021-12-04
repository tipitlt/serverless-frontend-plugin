'use strict';
const readDir = require('recursive-readdir');
const { readFileSync, fstat } = require('fs');
const { CloudFormation, S3 } = require('aws-sdk');
const {
  execCmd,
} = require('./lib/child_process');

const defaultTemplate = require('./cloudformation-templates/default.json');

class ServerlessFrontendPlugin {
  name = 'serverless-frontend-plugin';

  constructor(serverless) {
    this.serverless = serverless;

    const region = this.getRegion();
    this.cfClient = new CloudFormation({ region });
    this.s3Client = new S3({ region });

    this.hooks = {
      'before:package:finalize': this.buildClient.bind(this),
      'before:deploy:deploy': this.deployClient.bind(this),
      'before:remove:remove': this.deleteClient.bind(this),
    };
  }

  async buildClient() {
    this.serverless.cli.log('Checking for frontend build commands...');
    const frontendConfig = this.getConfig();
    const {
      build = {},
    } = frontendConfig;

    const {
      cwdDir = 'client',
      command = ['echo', 'no', 'command'],
    } = build;

    const cmd = command[0];
    const options = command.splice(1, command.length -1);

    await execCmd(cmd, options, cwdDir, this.serverless.cli.log);
  }


  async bucketExists() {
    const bucketName = this.getBucketName();
    const s3Client = this.getS3Client();

    try {
      await s3Client.headBucket({ Bucket: bucketName }).promise();
      return true;
    } catch (error) {
      return false;
    }
  }

  async deployClient() {
    const frontendConfig = this.getConfig();
    const {
      distDir = 'frontend/dist',
      bucket = {},
    } = frontendConfig;

    const {
      existing = false,
      indexDocument = 'index.html',
      errorDocument = 'index.html',
    } = bucket;

    const stackName = this.getStackName();
    const cfClient = this.getCloudFormationClient();
    const bucketName = this.getBucketName();

    const stackExists = await this.stackExists();
    const cfParams = {
      StackName: stackName,
      TemplateBody: JSON.stringify(defaultTemplate),
      Parameters: [
        {
          ParameterKey: 'Stage',
          ParameterValue: this.serverless.service.provider.stage,
        },
        {
          ParameterKey: 'ServiceName',
          ParameterValue: this.serverless.service.service,
        },
        {
          ParameterKey: 'BucketName',
          ParameterValue: bucketName,
        },
        {
          ParameterKey: 'IndexDocument',
          ParameterValue: indexDocument,
        },
        {
          ParameterKey: 'ErrorDocument',
          ParameterValue: errorDocument,
        },
      ],
    };

    if (!existing) {
      if (!stackExists) {
        await cfClient.createStack(cfParams).promise();
      } else {
        await cfClient.updateStack(cfParams).promise()
          .catch((e) => {
            if (e.message.match(/No updates are to be performed/)) {
              return Promise.resolve();
            }
            throw e;
          });
      }
  
      await this.waitForStackComplete();
    }

    const frontendFiles = await readDir(distDir);
    const s3Client = this.getS3Client();

    await Promise.all(frontendFiles.map(file => {
      const filePathArr = file.split('/');
      const key = filePathArr[filePathArr.length - 1];
      this.serverless.cli.log(`Uploading ${file} to ${bucketName}/${key}`);

      return s3Client.putObject({
        Bucket: bucketName,
        Key: key,
        Body: readFileSync(file),
        ContentDisposition: 'text/html',
        /* If index.html, set cache for 5 minutes; else 24 hours */
        CacheControl: `max-age=${key === 'index.html' ? 300 : 86400}`,
      }).promise()
    }));

    this.serverless.cli.log(`frontend stack name: ${stackName} finished deploying.`);
    const outputs = await this.getStackOutputs();
    this.serverless.cli.log(JSON.stringify(outputs, undefined, 2));
  }

  async deleteClient() {
    const bucketExists = await this.bucketExists();

    if (bucketExists) {
      const bucketName = this.getBucketName();
      const s3Client = this.getS3Client();
      this.serverless.cli.log(`Removing objects from ${bucketName}...`);

      let existingItems = true;
      let nextMarker;

      while(existingItems) {
        const {
          IsTruncated,
          Contents,
          Marker,
        } = await s3Client.listObjects({
          Bucket: bucketName,
          ...nextMarker && { Marker: nextMarker },
        }).promise();

        await Promise.all(Contents.map((item) => {
          const { Key } = item;
          return s3Client.deleteObject({ Bucket: bucketName, Key }).promise();
        }));

        nextMarker = Marker;
        existingItems = !IsTruncated && !!Marker;
      }
    }

    const stackName = this.getStackName();
    const stackExists = await this.stackExists();
    if (stackExists) {
      this.serverless.cli.log(`Initiating deleteStack() for ${stackName}`);
      await this.cfClient.deleteStack({
        StackName: stackName,
      }).promise();
    }
  }

  getBucketName() {
    const { bucket = {} } = this.getConfig();
    const stage = this.serverless.service.stage;
    return bucket.name || `${this.serverless.service.service}${!!stage ? `-${stage}` : ''}-${this.getRegion()}`;
  }

  getConfig() {
    return this.serverless.service.custom[this.name] || {};
  }

  /**
   * 
   * @returns {CloudFormation} CloudFormation Client
   */
  getCloudFormationClient() {
    return this.cfClient;
  }

  /**
   * 
   * @returns {S3} S3 Client
   */
  getS3Client() {
    return this.s3Client;
  }

  getRegion() {
    return this.serverless.service.provider.region || process.env.AWS_REGION;
  }

  getStackName() {
    return this.serverless.service.provider.stackName 
      || `${this.serverless.service.service}-${this.serverless.service.provider.stage}-frontend`;
  }

  async getStackOutputs() {
    const stackName = this.getStackName();
    const cfClient = this.getCloudFormationClient();
    const { Stacks: stacks } = await cfClient.describeStacks({ StackName: stackName }).promise();
    const { Outputs: outputs } = stacks.pop();
    return outputs;
  }

  async stackExists() {
    const cfClient = this.getCloudFormationClient();
    try {
      await cfClient.describeStacks({
        StackName: this.getStackName(),
      }).promise();
      return true;
    } catch (error) {
      // this.serverless.cli.log(error.message);
      return false;
    }
  }

  async waitForStackComplete() {
    const stackName = this.getStackName();
    const cfClient = this.getCloudFormationClient();
    const { Stacks: stacks } = await cfClient.describeStacks({ StackName: stackName }).promise();
    const { StackStatus: status, StackStatusReason: message } = stacks.pop();
    this.serverless.cli.log(`${stackName} status: ${status}`);

    if (status.match(/(FAILED|ROLLBACK)/)) {
      throw new Error(`serverless-frontend-plugin stack: ${stackName} failed with a status of ${status} due to: ${message}`);
    }

    if (status.match(/(COMPLETE)/)) {
      return null;
    }

    await new Promise(res => setTimeout(res, 3000));
    return this.waitForStackComplete();
  }
}

module.exports = ServerlessFrontendPlugin;
