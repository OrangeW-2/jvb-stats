# Just Volleyball Stats

Static analytics site for Just Volleyball. Computes Elo, Bradley-Terry MMR, Box BPM, Markov EPA, Rally RAPM, VPM, V-WAR, and others.

Live site: https://orangew-2.github.io/jvb-stats/

## Requirements

- Python 3
- `numpy`, `scipy`, `scikit-learn`
- `zstandard` (optional, for `.vbtsess` VBT telemetry)

```powershell
pip install numpy scipy scikit-learn zstandard
```

## Usage

Build `index.html` from local Godot userdata (`%APPDATA%\Godot\app_userdata\volleyball`) and any `.zip` bundles in `submissions/`:

```powershell
python build_site.py
```

Build strictly from `submissions/` without local userdata:

```powershell
python build_site.py --no-local
```

## Collecting Player Data

Run `collect_just_volleyball_data.bat` on Windows to package a player's Just Volleyball data into a `.zip`, then drop the `.zip` into `submissions/` and rebuild.
