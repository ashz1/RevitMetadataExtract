# Revit RVT Metadata Extractor - by Aashay

This project is a simple web app that extracts metadata from Autodesk Revit (.rvt) files using the Autodesk Forge Platform Services (APS) APIs after you select and extract any files.

## Features

- Uploads selected RVT files to Autodesk Forge cloud storage.
- Converts RVT files to a readable format using Forge Model Derivative API.
- Extracts metadata from the converted files.
- Saves metadata as JSON files you can download.
- Supports multiple RVT files with a user-friendly web interface.

## Technologies Used

- Node.js and Express for backend server
- Autodesk Forge Platform Services for file handling and metadata extraction
- Axios for HTTP requests
- Bootstrap for frontend styling
- Marked for rendering Markdown README as HTML

## Setup and Running

1. Clone the repo and place your RVT files in the project root.
2. Create a `.env` file with your Autodesk Forge credentials and a unique bucket name:

