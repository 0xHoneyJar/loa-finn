# deploy/terraform/backend.tf — S3 + DynamoDB state backend (Sprint 4 Task 4.0, Flatline IMP-008)
#
# Bootstrap: Create the S3 bucket and DynamoDB table before running terraform init.
#   aws s3api create-bucket --bucket arrakis-terraform-state --region us-east-1
#   aws s3api put-bucket-versioning --bucket arrakis-terraform-state --versioning-configuration Status=Enabled
#   aws dynamodb create-table \
#     --table-name terraform-locks \
#     --attribute-definitions AttributeName=LockID,AttributeType=S \
#     --key-schema AttributeName=LockID,KeyType=HASH \
#     --billing-mode PAY_PER_REQUEST

terraform {
  backend "s3" {
    bucket         = "arrakis-terraform-state"
    key            = "loa-finn/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "terraform-locks"
    encrypt        = true
  }
}
