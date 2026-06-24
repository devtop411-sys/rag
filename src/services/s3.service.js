import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { S3_BUCKET, S3_PREFIX, PRESIGN_TTL } from "../config/constants.js";

export const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

export { S3_BUCKET, S3_PREFIX, PRESIGN_TTL };
export { PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand, getSignedUrl };
