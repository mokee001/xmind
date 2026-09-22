import os
from PIL import Image

def generate_six_color_bars():
    width = 1200
    height = 1600
    img = Image.new("RGB", (width, height))
    
    colors = [
        (0, 0, 0),         # Black
        (255, 255, 255),   # White
        (255, 255, 0),     # Yellow
        (255, 0, 0),       # Red
        (0, 0, 255),       # Blue
        (0, 255, 0)        # Green
    ]
    
    for i in range(6):
        y_start = (i * height) // 6
        y_end = ((i + 1) * height) // 6
        color = colors[i]
        
        # Fill the region
        for y in range(y_start, y_end):
            for x in range(width):
                img.putpixel((x, y), color)
                
    img.save("output/eink-test/six-color-bars.png", "PNG")
    print("PNG generated successfully")

if __name__ == "__main__":
    generate_six_color_bars()
