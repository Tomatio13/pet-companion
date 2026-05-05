from setuptools import setup, find_packages

setup(
    name="pet-companion",
    version="0.1.0",
    packages=find_packages(),
    include_package_data=True,
    package_data={
        "petcompanion": ["pet_static/**/*"],
    },
    entry_points={
        "console_scripts": [
            "pet-companion=petcompanion.cli:main",
        ],
    },
    python_requires=">=3.10",
)
