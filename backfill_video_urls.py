#!/usr/bin/env python3
"""
Backfill video URLs for completed tasks that have MP4 files but no video_url in database.
This script uploads existing MP4 files to OSS and updates via Backend API.
"""
import os
import sys
from pathlib import Path

# Add worker package to path
sys.path.insert(0, '/app')

from oss_uploader import OssUploader
import requests

# Task ID to filename mapping (based on completion times)
TASKS = {
    '3fc583ee-d777-4795-aeed-a395e22da619': '/app/output/image_to_video-20260909-112106.mp4',  # completed 11:21:16
    '7dc398ed-b893-460b-bd73-3d2d271098ed': '/app/output/image_to_video-20260909-112301.mp4',  # completed 11:23:11
}

def main():
    backend_url = os.environ.get('BACKEND_URL', 'http://video-backend:3000')

    # Initialize OSS uploader (reads from settings/env)
    oss_uploader = OssUploader()

    for task_id, local_path in TASKS.items():
        print(f"\n[{task_id}] Processing...")

        # Check if file exists
        if not Path(local_path).exists():
            print(f"  ⚠️  File not found: {local_path}")
            continue

        # Upload to OSS
        object_key = f"videos/{task_id}.mp4"
        print(f"  Uploading to OSS: {object_key}")
        oss_url = oss_uploader.upload(local_path, object_key)
        print(f"  ✓ Uploaded: {oss_url}")

        # Update via Backend API (PATCH /api/tasks/:id)
        try:
            response = requests.patch(
                f"{backend_url}/api/tasks/{task_id}",
                json={"videoUrl": oss_url},
                timeout=10
            )
            response.raise_for_status()
            print(f"  ✓ Database updated via API")
        except Exception as e:
            print(f"  ✗ API update failed: {e}")
            raise

    print("\n✓ All tasks backfilled successfully")

if __name__ == '__main__':
    main()
