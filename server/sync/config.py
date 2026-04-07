"""
Configuration for the Factory Near Me sync pipeline.
Maps government API endpoints and column names to our Supabase schema.
"""

# =============================================================================
# API Endpoints (CSV versions from openapi.industry.go.th)
# =============================================================================
ENDPOINTS = {
    "Business_Location": {
        "url": "https://openapi.industry.go.th/gdcatalog/Business_Location_CSV.php",
        "download_url": "https://openapi.industry.go.th/gdcatalog/Business_Location_CSV.php?download_all=1",
        "description": "Factory locations with operator info and status",
        "target_tables": ["businesses", "factories"],
    },
    "Factory_Data": {
        "url": "https://openapi.industry.go.th/gdcatalog/Factory_Data_CSV.php",
        "download_url": "https://openapi.industry.go.th/gdcatalog/Factory_Data_CSV.php?download_all=1",
        "description": "Detailed factory data with capital, workers, horsepower",
        "target_tables": ["businesses", "factories"],
    },
    "Factory_Operation_Permit": {
        "url": "https://openapi.industry.go.th/gdcatalog/Factory_Operation_Permit_CSV.php",
        "download_url": "https://openapi.industry.go.th/gdcatalog/Factory_Operation_Permit_CSV.php?download_all=1",
        "description": "Operating permits and licensing history",
        "target_tables": ["permits"],
    },
    "Sum_Factory_Local": {
        "url": "https://openapi.industry.go.th/gdcatalog/Sum_Factory_Local_CSV.php",
        "download_url": "https://openapi.industry.go.th/gdcatalog/Sum_Factory_Local_CSV.php?download_all=1",
        "description": "Summary statistics by locality",
        "target_tables": ["factory_statistics"],
    },
    "Sum_Status_Factory_Local": {
        "url": "https://openapi.industry.go.th/gdcatalog/Sum_Status_Factory_Local_CSV.php",
        "download_url": "https://openapi.industry.go.th/gdcatalog/Sum_Status_Factory_Local_CSV.php?download_all=1",
        "description": "Summary statistics by status and locality",
        "target_tables": ["factory_statistics"],
    },
}

# Note: Factory_By_BusinessID is excluded because FID is empty in all records,
# making it unusable for joins. Business data is extracted from the other endpoints.

# =============================================================================
# Column Mappings: API CSV columns → Supabase table columns
# =============================================================================

# Business_Location endpoint → factories table
BUSINESS_LOCATION_TO_FACTORIES = {
    "DISPFACREG": "registration_display",
    "FNAME": "name",
    "FADDR": "_addr",         # Will be combined into address_full
    "FMOO": "_moo",
    "FSOI": "_soi",
    "FROAD": "_road",
    "FTUMNAME": "sub_district",
    "FAMPNAME": "district",
    "FPROVNAME": "province",
    "STATUS": "status",
    "LAT": "lat",
    "LNG": "lng",
    "LAST_UPDATE": "_last_update",
}

# Factory_Data endpoint → factories table (richer dataset)
FACTORY_DATA_TO_FACTORIES = {
    "FACREG": "id",                   # Primary key
    "DISPFACREG": "registration_display",
    "FID": "fid",
    "FACTYPE": "factory_type",
    "FNAME": "name",
    "ONAME": "_oname",                # Used to create business link
    "OBJECT": "_object",              # Business objective (goes to businesses)
    "FADDR": "_addr",
    "FMOO": "_moo",
    "FSOI": "_soi",
    "FROAD": "_road",
    "FTUMNAME": "sub_district",
    "FAMPNAME": "district",
    "FPROVNAME": "province",
    "TOTAL_CAP": "capital_investment",
    "TOTAL_WORKER": "total_workers",
    "HP": "horsepower",
    "LAT": "lat",
    "LNG": "lng",
    "ISIC_CODE": "isic_code",
    "ESTATE": "_estate",
    "ESTATE_NAME_TH": "estate_name",
    "LAST_UPDATE": "_last_update",
}

# Factory_Operation_Permit endpoint → permits table
PERMIT_TO_PERMITS = {
    "DISPFACREG": "permit_no",
    "FID": "factory_fid",
    "FNAME": "_fname",                # Denormalized, not stored
    "ONAME": "_oname",                # Denormalized, not stored
    "OBJECT": "_object",              # Denormalized, not stored
    "POKDATE": "issue_date",
    "STATUS": "permit_status",
    "LAST_UPDATE": "_last_update",
}

# Sum endpoints → factory_statistics table
SUM_TO_STATISTICS = {
    "YEAR": "year",
    "MONTH": "month",
    "FPROVNAME": "province",
    "TSIC": "tsic_code",
    "DESCR": "description",
    "STATUS": "status",
    "TOTAL": "total",
    "LAST_UPDATE": "last_update",
}

# =============================================================================
# Batch sizes for upsert operations
# =============================================================================
UPSERT_BATCH_SIZE = 500  # Records per batch for Supabase upsert
FETCH_TIMEOUT = 300      # Seconds to wait for CSV download
