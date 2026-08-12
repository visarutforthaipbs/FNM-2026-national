import csv
import glob

files = glob.glob("*.csv") + glob.glob("server/**/*.csv", recursive=True) + glob.glob("server/data/*.csv")
print("Found CSV files:", files)

for fpath in files[:5]:
    try:
        with open(fpath, "r", encoding="utf-8-sig") as f:
            reader = csv.reader(f)
            headers = next(reader)
            print(f"\nFile: {fpath}")
            print("Headers:", headers[:10])
    except Exception as e:
        print(f"Error reading {fpath}:", e)
