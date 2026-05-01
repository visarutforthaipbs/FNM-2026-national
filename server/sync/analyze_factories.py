import pandas as pd
import os

def run_analysis(file_path):
    if not os.path.exists(file_path):
        print(f"❌ Error: {file_path} not found.")
        return

    print(f"📊 Analyzing {file_path}...")
    # Low memory mode to handle large files, though 115MB is fine for most RAM
    df = pd.read_csv(file_path)

    print("\n--- Basic Info ---")
    print(f"Total Records: {len(df):,}")
    
    # Filter out weird non-string or numeric noise in status if any
    print("\n--- Status Distribution ---")
    if 'status' in df.columns:
        status_counts = df['status'].value_counts()
        # Filter for typical Thai status strings or known categories
        print(status_counts.head(10))
    
    print("\n--- Top 10 Provinces ---")
    if 'province' in df.columns:
        print(df['province'].value_counts().head(10))

    print("\n--- Top 10 Factory Types ---")
    if 'factory_type' in df.columns:
        print(df['factory_type'].value_counts().head(10))

    print("\n--- Numerical Summaries ---")
    num_cols = ['total_workers', 'capital_investment', 'horsepower']
    available_num_cols = []
    
    for col in num_cols:
        if col in df.columns:
            # Force numeric, turning errors to NaN
            df[col] = pd.to_numeric(df[col], errors='coerce')
            available_num_cols.append(col)
            
    if available_num_cols:
        desc = df[available_num_cols].describe().loc[['mean', 'max']]
        sums = df[available_num_cols].sum().to_frame().T
        sums.index = ['sum']
        summary = pd.concat([desc, sums])
        
        pd.options.display.float_format = '{:,.2f}'.format
        print(summary)

    print("\n--- Missing Coordinates ---")
    if 'lat' in df.columns and 'lng' in df.columns:
        # Also handle cases where lat/lng might be string 'null' or empty
        df['lat'] = pd.to_numeric(df['lat'], errors='coerce')
        df['lng'] = pd.to_numeric(df['lng'], errors='coerce')
        missing_coords = df[df['lat'].isna() | df['lng'].isna()].shape[0]
        print(f"Records missing Lat/Lng: {missing_coords:,} ({ (missing_coords/len(df))*100:.2f}%)")

if __name__ == "__main__":
    run_analysis("all_factories_export.csv")
