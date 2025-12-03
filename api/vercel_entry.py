import sys
import os

# Add the parent directory to sys.path so we can import main
sys.path.append(os.path.dirname(os.path.dirname(__file__)))

from main import app
