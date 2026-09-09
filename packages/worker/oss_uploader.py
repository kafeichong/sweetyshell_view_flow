import oss2
from config import get_settings

settings = get_settings()

SIGNED_URL_EXPIRE_SECONDS = 7 * 24 * 60 * 60  # 7 天


class OssUploader:
    """阿里云 OSS 上传器 - bucket 为私有权限，使用签名 URL 授权访问"""

    def __init__(self):
        # 使用 settings 注入的 RAM 凭证，不在代码内硬编码任何敏感信息。
        auth = oss2.Auth(settings.oss_access_key_id, settings.oss_access_key_secret)
        self.bucket = oss2.Bucket(auth, settings.oss_endpoint, settings.oss_bucket)
        self.bucket_name = settings.oss_bucket
        self.region = settings.oss_region

    def upload(self, local_path: str, object_key: str) -> str:
        """上传本地文件到 OSS，返回有效期 7 天的签名访问 URL"""
        # 返回 OSS 签名链接，默认 7 天有效，符合“产物私有化+时效访问”策略。
        self.bucket.put_object_from_file(object_key, local_path)
        return self.bucket.sign_url("GET", object_key, SIGNED_URL_EXPIRE_SECONDS)
