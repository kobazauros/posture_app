import posture_annotator
import sys

photo_path = '/home/posture_app/received_photos/6363039972_20260602_220210_photo_3.jpg'
try:
    img, measurements = posture_annotator.process_photo(photo_path, 'frontal')
    print("Measurements:", measurements)
    if img:
        print("Image dimensions:", img.size)
except Exception as e:
    print("Error:", e)
    import traceback
    traceback.print_exc()
