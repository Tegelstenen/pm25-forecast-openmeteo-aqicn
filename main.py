import modal
import nbformat
import nbclient

import os
import subprocess
import shutil
from pathlib import Path
from datetime import datetime


app = modal.App(name="pm25-forecast-openmeteo-aqicn")
image = (
    modal.Image.debian_slim()
    .apt_install("git")
    .pip_install_from_pyproject(pyproject_toml="pyproject.toml")
    .add_local_dir("notebooks", remote_path="/root/notebooks", copy=True)
    .add_local_python_source("utils")
)
vol = modal.Volume.from_name("id2223-volume", create_if_missing=True)

def push_results():
    token = os.environ["GITHUB_PAT"]
    repo_name = "pm25-forecast-openmeteo-aqicn"
    repo_url = f"https://{token}:x-oauth-basic@github.com/Tegelstenen/{repo_name}.git"

    # Clone the repository
    subprocess.run(["git", "clone", repo_url], check=True)
    os.chdir(repo_name)

    # Configure git
    subprocess.run(["git", "config", "user.email", "modal@example.com"], check=True)
    subprocess.run(["git", "config", "user.name", "Modal Bot"], check=True)

    # Create images directory if it doesn't exist
    images_dir = Path("images")
    images_dir.mkdir(exist_ok=True)

    # Add all changes
    subprocess.run(["git", "add", "models/"], check=True)

    # Create commit with timestamp
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    commit_msg = f"Update forecast images - {timestamp}"

    # Only commit if there are changes
    result = subprocess.run(["git", "diff", "--staged", "--quiet"], capture_output=True)
    if result.returncode != 0:  # There are changes
        subprocess.run(["git", "commit", "-m", commit_msg], check=True)
        subprocess.run(["git", "push"], check=True)
        print(f"Successfully pushed images to GitHub at {timestamp}")
    else:
        print("No changes to commit")


def run_notebook(notebook_path: str):
    """Run notebook by converting to python script for real-time output"""
    print(f"\n{'='*80}")
    print(f"Running notebook: {notebook_path}")
    print(f"{'='*80}\n")

    # Convert notebook to python script
    py_script = notebook_path.replace('.ipynb', '_temp.py')

    # First convert to python script
    subprocess.run(
        ["jupyter", "nbconvert", "--to", "python", "--output", py_script, notebook_path],
        check=True
    )

    # Then execute with ipython for real-time output (needed for get_ipython() support)
    subprocess.run(
        ["ipython", "--no-banner", "--no-confirm-exit", "-c", f"%run {py_script}"],
        check=True
    )

    # Clean up temp file
    Path(py_script).unlink(missing_ok=True)

    print(f"\n{'='*80}")
    print(f"Finished notebook: {notebook_path}")
    print(f"{'='*80}\n")

def sanity_checks():
    print("Ensure notebook files exist")
    feature_pipeline_path = Path("/root/notebooks/2_feature_pipeline.ipynb")
    if not feature_pipeline_path.exists():
        raise FileNotFoundError(f"Required file {feature_pipeline_path} does not exist")
    batch_inference_path = Path("/root/notebooks/4_batch_inference.ipynb")
    if not batch_inference_path.exists():
        raise FileNotFoundError(f"Required file {batch_inference_path} does not exist")
    print("All required files found")

@app.function(
    schedule=modal.Period(days=1),
    image=image,
    volumes={"/data": vol},
    secrets=[modal.Secret.from_name("custom-secret")],
    timeout=3600,  # 1 hour timeout
)
def pipline():
    print("------ Running pipeline ------")
    sanity_checks()

    # Create necessary directories
    Path("/root/models").mkdir(parents=True, exist_ok=True)
    print("Created /root/models directory")

    run_notebook("/root/notebooks/2_feature_pipeline.ipynb")
    run_notebook("/root/notebooks/4_batch_inference.ipynb")
    push_results()