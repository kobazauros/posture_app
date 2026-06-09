#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Posture annotation using MediaPipe Pose.
Draws posture guide lines, spine curves, and blurs faces on saved images.
"""
import math
from pathlib import Path

try:
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision
    import numpy as np
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
    from scipy.interpolate import make_interp_spline, UnivariateSpline
    _HAS_DEPS = True
except ImportError as e:
    print(f"Failed to import dependencies: {e}")
    _HAS_DEPS = False

# MediaPipe Pose Landmarks
NOSE = 0
LEFT_EYE_INNER = 1
LEFT_EYE = 2
LEFT_EYE_OUTER = 3
RIGHT_EYE_INNER = 4
RIGHT_EYE = 5
RIGHT_EYE_OUTER = 6
LEFT_EAR = 7
RIGHT_EAR = 8
MOUTH_LEFT = 9
MOUTH_RIGHT = 10
LEFT_SHOULDER = 11
RIGHT_SHOULDER = 12
LEFT_ELBOW = 13
RIGHT_ELBOW = 14
LEFT_WRIST = 15
RIGHT_WRIST = 16
LEFT_HIP = 23
RIGHT_HIP = 24
LEFT_KNEE = 25
RIGHT_KNEE = 26
LEFT_ANKLE = 27
RIGHT_ANKLE = 28
LEFT_HEEL = 29
RIGHT_HEEL = 30
LEFT_FOOT_INDEX = 31
RIGHT_FOOT_INDEX = 32

FACE_INDICES = [
    NOSE, LEFT_EYE_INNER, LEFT_EYE, LEFT_EYE_OUTER,
    RIGHT_EYE_INNER, RIGHT_EYE, RIGHT_EYE_OUTER,
    LEFT_EAR, RIGHT_EAR, MOUTH_LEFT, MOUTH_RIGHT
]


def _get_landmark_px(landmarks, index, img_width, img_height):
    """Convert normalized landmark to pixel coordinates."""
    lm = landmarks[index]
    if hasattr(lm, 'visibility') and lm.visibility is not None and lm.visibility < 0.3:
        return None
    return (int(lm.x * img_width), int(lm.y * img_height))


def _blur_face(image, landmarks, img_width, img_height):
    """Applies a heavy blur to the face region."""
    pts = []
    for idx in FACE_INDICES:
        pt = _get_landmark_px(landmarks, idx, img_width, img_height)
        if pt:
            pts.append(pt)

    if len(pts) < 3:
        return image

    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)

    # Padding
    pad_x = int((max_x - min_x) * 0.6)
    pad_y = int((max_y - min_y) * 0.7)

    box = (
        max(0, min_x - pad_x),
        max(0, min_y - pad_y),
        min(img_width, max_x + pad_x),
        min(img_height, max_y + pad_y)
    )

    if box[2] <= box[0] or box[3] <= box[1]:
        return image

    # Crop, blur, and paste back with an ellipse mask
    face_region = image.crop(box)

    # Dynamic blur radius based on image size (e.g. 2% of max dimension)
    blur_radius = max(10, int(max(img_width, img_height) * 0.02))
    face_region = face_region.filter(ImageFilter.GaussianBlur(radius=blur_radius))

    mask = Image.new('L', face_region.size, 0)
    draw_mask = ImageDraw.Draw(mask)
    draw_mask.ellipse((0, 0, face_region.width, face_region.height), fill=255)

    image.paste(face_region, box, mask)
    return image


def _calculate_angle(p1, p2):
    """Calculates angle in degrees between two points relative to horizontal."""
    dx = p2[0] - p1[0]
    dy = p2[1] - p1[1]
    angle = math.degrees(math.atan2(dy, dx))
    # Normalize to -90 to +90 where 0 is perfectly horizontal
    if angle > 90:
        angle -= 180
    elif angle < -90:
        angle += 180
    return angle


def _draw_dashed_line(draw, pt1, pt2, fill, width, dash_len=10):
    dx = pt2[0] - pt1[0]
    dy = pt2[1] - pt1[1]
    dist = math.hypot(dx, dy)
    if dist == 0:
        return
    dashes = int(dist / dash_len)
    for i in range(dashes):
        if i % 2 == 0:
            start_t = i / dashes
            end_t = (i + 1) / dashes
            x1 = pt1[0] + dx * start_t
            y1 = pt1[1] + dy * start_t
            x2 = pt1[0] + dx * end_t
            y2 = pt1[1] + dy * end_t
            draw.line([(x1, y1), (x2, y2)], fill=fill, width=width)

def _draw_joint(draw, pt, radius, fill=(255, 255, 255, 255), outline=(0, 0, 0, 100)):
    """Draws a circular marker for a joint."""
    draw.ellipse((pt[0]-radius, pt[1]-radius, pt[0]+radius, pt[1]+radius), fill=fill, outline=outline, width=2)

def _draw_badge_text(draw, text, position, font, text_color=(255, 255, 255, 255), bg_color=(0, 0, 0, 150)):
    """Draws text inside a semi-transparent rounded rectangle badge."""
    x, y = position
    if hasattr(draw, "textbbox"):
        # Get exact bounding box for the text drawn at (x, y)
        left, top, right, bottom = draw.textbbox((x, y), text, font=font)
    else:
        w, h = draw.textsize(text, font=font)
        left, top = x, y
        right, bottom = x + w, y + h
    
    pad_x, pad_y = 6, 4
    
    # Draw badge background perfectly around the text's bounding box
    draw.rounded_rectangle((left - pad_x, top - pad_y, right + pad_x, bottom + pad_y), radius=4, fill=bg_color)
    draw.text((x, y), text, fill=text_color, font=font)


# ---------------------------------------------------------------------------
# Spine line helpers (side-view only)
# ---------------------------------------------------------------------------

def _avg(pt1, pt2):
    """Return midpoint of two points, or whichever is not None."""
    if pt1 and pt2:
        return ((pt1[0] + pt2[0]) // 2, (pt1[1] + pt2[1]) // 2)
    return pt1 or pt2


# ---------------------------------------------------------------------------
# View-specific annotation functions
# ---------------------------------------------------------------------------

def _annotate_frontal(image, draw, landmarks, img_width, img_height, is_back=False):
    """Draws shoulder, pelvis, knee, and ankle lines with angles."""
    # Shoulders
    ls = _get_landmark_px(landmarks, LEFT_SHOULDER, img_width, img_height)
    rs = _get_landmark_px(landmarks, RIGHT_SHOULDER, img_width, img_height)
    # Pelvis
    lh = _get_landmark_px(landmarks, LEFT_HIP, img_width, img_height)
    rh = _get_landmark_px(landmarks, RIGHT_HIP, img_width, img_height)
    # Knees
    lk = _get_landmark_px(landmarks, LEFT_KNEE, img_width, img_height)
    rk = _get_landmark_px(landmarks, RIGHT_KNEE, img_width, img_height)
    # Ankles
    la = _get_landmark_px(landmarks, LEFT_ANKLE, img_width, img_height)
    ra = _get_landmark_px(landmarks, RIGHT_ANKLE, img_width, img_height)
    # Ears
    lear = _get_landmark_px(landmarks, LEFT_EAR, img_width, img_height)
    rear = _get_landmark_px(landmarks, RIGHT_EAR, img_width, img_height)

    measurements = {}

    line_width = max(2, int(max(img_width, img_height) * 0.004))
    joint_radius = line_width * 2
    dash_length = line_width * 4

    try:
        font_path = str(Path(__file__).parent / 'fonts' / 'Roboto-Regular.ttf')
        font_size = max(14, int(max(img_width, img_height) * 0.018))
        font = ImageFont.truetype(font_path, font_size)
    except Exception:
        font = ImageFont.load_default()

    line_color = (255, 255, 255, 200)

    def draw_segment(p_left, p_right, name, offset_y=-30):
        if not (p_left and p_right):
            return

        img_left_pt = p_left if is_back else p_right
        img_right_pt = p_right if is_back else p_left

        angle = _calculate_angle(img_left_pt, img_right_pt)
        measurements[name] = angle

        overlay = Image.new('RGBA', image.size, (255, 255, 255, 0))
        d = ImageDraw.Draw(overlay)

        dx = img_right_pt[0] - img_left_pt[0]
        dy = img_right_pt[1] - img_left_pt[1]
        ext_left_pt = (img_left_pt[0] - 0.25 * dx, img_left_pt[1] - 0.25 * dy)
        ext_right_pt = (img_right_pt[0] + 0.25 * dx, img_right_pt[1] + 0.25 * dy)

        d.line([ext_left_pt, ext_right_pt], fill=line_color, width=line_width)

        _draw_joint(d, img_left_pt, joint_radius, fill=(255, 255, 255, 255), outline=(0, 0, 0, 100))
        _draw_joint(d, img_right_pt, joint_radius, fill=(255, 255, 255, 255), outline=(0, 0, 0, 100))

        image.paste(Image.alpha_composite(image.convert('RGBA'), overlay), (0, 0))

        badge_bg = (30, 30, 30, 180)
            
        text = f"{angle:+.1f}°"
        text_x = p_left[0] + max(10, int(img_width * 0.015))
        text_y = p_left[1] + offset_y
        
        txt_overlay = Image.new('RGBA', image.size, (255, 255, 255, 0))
        d_txt = ImageDraw.Draw(txt_overlay)
        _draw_badge_text(d_txt, text, (text_x, text_y), font, text_color=(255, 255, 255, 255), bg_color=badge_bg)
        image.paste(Image.alpha_composite(image.convert('RGBA'), txt_overlay), (0, 0))

    draw_segment(ls, rs, 'shoulder_angle', -40)
    draw_segment(lh, rh, 'hip_angle', -40)
    draw_segment(lk, rk, 'knee_angle', -30)
    draw_segment(la, ra, 'ankle_angle', -30)

    # Plumb line from ear level to ankle level
    mid_ear = _avg(lear, rear)
    if not mid_ear:
        mid_ear = _avg(ls, rs)
    mid_ankle = _avg(la, ra)
    if not mid_ankle:
        mid_ankle = _avg(lk, rk)
        if not mid_ankle:
            mid_ankle = _avg(lh, rh)

    if mid_ear and mid_ankle:
        plumb_overlay = Image.new('RGBA', image.size, (255, 255, 255, 0))
        d_plumb = ImageDraw.Draw(plumb_overlay)
        
        ref_x = mid_ankle[0]
        y_top = mid_ear[1]
        y_bot = mid_ankle[1]
        
        d_plumb.line([(ref_x, y_top), (ref_x, y_bot)], fill=(0, 255, 255, 160), width=max(1, line_width-1))
        image.paste(Image.alpha_composite(image.convert('RGBA'), plumb_overlay), (0, 0))

    return measurements


def _annotate_side(image, draw, landmarks, img_width, img_height,
                   is_right_side=False):
    """Draws plumb line and posture guide lines."""
    measurements = {}

    line_width = max(2, int(max(img_width, img_height) * 0.004))
    joint_radius = line_width * 2

    try:
        font_path = str(Path(__file__).parent / 'fonts' / 'Roboto-Regular.ttf')
        font_size = max(14, int(max(img_width, img_height) * 0.018))
        font = ImageFont.truetype(font_path, font_size)
    except Exception:
        font = ImageFont.load_default()

    line_color = (255, 255, 255, 200)

    # Calculate midpoints for side annotations instead of using only the visible side
    left_ankle = _get_landmark_px(landmarks, LEFT_ANKLE, img_width, img_height)
    right_ankle = _get_landmark_px(landmarks, RIGHT_ANKLE, img_width, img_height)
    ankle = _avg(left_ankle, right_ankle)

    left_ear = _get_landmark_px(landmarks, LEFT_EAR, img_width, img_height)
    right_ear = _get_landmark_px(landmarks, RIGHT_EAR, img_width, img_height)
    ear = _avg(left_ear, right_ear)

    left_shoulder = _get_landmark_px(landmarks, LEFT_SHOULDER, img_width, img_height)
    right_shoulder = _get_landmark_px(landmarks, RIGHT_SHOULDER, img_width, img_height)
    shoulder = _avg(left_shoulder, right_shoulder)

    left_hip = _get_landmark_px(landmarks, LEFT_HIP, img_width, img_height)
    right_hip = _get_landmark_px(landmarks, RIGHT_HIP, img_width, img_height)
    hip = _avg(left_hip, right_hip)

    # Draw individual left and right markers
    # lr_overlay = Image.new('RGBA', image.size, (255, 255, 255, 0))
    # d_lr = ImageDraw.Draw(lr_overlay)
    
    # left_color = (255, 50, 50, 200)   # Red for Left
    # right_color = (50, 255, 50, 200)  # Green for Right
    
    # for l_pt, r_pt in [(left_ankle, right_ankle), (left_ear, right_ear), 
    #                    (left_shoulder, right_shoulder), (left_hip, right_hip)]:
    #     if l_pt:
    #         _draw_joint(d_lr, l_pt, joint_radius, fill=left_color, outline=(0, 0, 0, 100))
    #     if r_pt:
    #         _draw_joint(d_lr, r_pt, joint_radius, fill=right_color, outline=(0, 0, 0, 100))
            
    # image.paste(Image.alpha_composite(image.convert('RGBA'), lr_overlay), (0, 0))

    def draw_side_segment(p_top, p_bottom, name, offset_x=20, offset_y=0):
        if not (p_top and p_bottom):
            return

        angle_val = _calculate_angle(p_top, p_bottom)
        deviation = abs(90.0 - abs(angle_val))
        measurements[name] = deviation

        overlay = Image.new('RGBA', image.size, (255, 255, 255, 0))
        d = ImageDraw.Draw(overlay)

        dx = p_bottom[0] - p_top[0]
        dy = p_bottom[1] - p_top[1]
        ext_top = (p_top[0] - 0.25 * dx, p_top[1] - 0.25 * dy)
        ext_bottom = (p_bottom[0] + 0.25 * dx, p_bottom[1] + 0.25 * dy)

        d.line([ext_top, ext_bottom], fill=line_color, width=line_width)

        _draw_joint(d, p_top, joint_radius, fill=(255, 255, 255, 255), outline=(0, 0, 0, 100))
        _draw_joint(d, p_bottom, joint_radius, fill=(255, 255, 255, 255), outline=(0, 0, 0, 100))

        image.paste(Image.alpha_composite(image.convert('RGBA'), overlay), (0, 0))

        badge_bg = (30, 30, 30, 180)
        text = f"{deviation:.1f}°"
        
        text_x = p_top[0] + offset_x
        text_y = p_top[1] + offset_y
        
        txt_overlay = Image.new('RGBA', image.size, (255, 255, 255, 0))
        d_txt = ImageDraw.Draw(txt_overlay)
        _draw_badge_text(d_txt, text, (text_x, text_y), font, text_color=(255, 255, 255, 255), bg_color=badge_bg)
        image.paste(Image.alpha_composite(image.convert('RGBA'), txt_overlay), (0, 0))

    # Draw side lines
    draw_side_segment(ear, shoulder, 'ear_shoulder_angle', offset_x=max(10, int(img_width * 0.015)), offset_y=-20)
    draw_side_segment(shoulder, hip, 'shoulder_hip_angle', offset_x=max(10, int(img_width * 0.015)), offset_y=20)

    # Plumb line from ear level to ankle level
    if ankle is not None and ear is not None:
        plumb_overlay = Image.new('RGBA', image.size, (255, 255, 255, 0))
        d_plumb = ImageDraw.Draw(plumb_overlay)
        ref_x = ankle[0] # Aligned with ankle
        d_plumb.line([(ref_x, ear[1]), (ref_x, ankle[1])], fill=(0, 255, 255, 160), width=max(1, line_width-1))
        
        # Mark ankle and ear on the plumb line
        _draw_joint(d_plumb, (ref_x, ankle[1]), joint_radius, fill=(255, 255, 255, 255), outline=(0, 0, 0, 100))
        _draw_joint(d_plumb, ear, joint_radius, fill=(255, 255, 255, 255), outline=(0, 0, 0, 100))
        
        image.paste(Image.alpha_composite(image.convert('RGBA'), plumb_overlay), (0, 0))

    # Forward head posture measurement
    if ear and shoulder:
        dx = ear[0] - shoulder[0]
        dy = ear[1] - shoulder[1]
        measurements['forward_head_angle'] = 180 - abs(math.atan2(dx, dy) * 180 / math.pi)
    
    if shoulder and hip:
        dx = shoulder[0] - hip[0]
        dy = shoulder[1] - hip[1]
        measurements['shoulder_hip_angle'] = 180 - abs(math.atan2(dx, dy) * 180 / math.pi)

    return measurements


def process_photo(image_path, view_type="frontal"):
    """
    Processes an image, applying face blur and drawing posture annotations.
    Returns (processed_pil_image, measurements_dict).

    view_type can be: "frontal", "back", "left_side", "right_side".
    """
    if not _HAS_DEPS:
        return None, {}

    try:
        # Ensure image is loaded properly
        image = Image.open(image_path).convert('RGB')
        img_width, img_height = image.size
    except Exception as e:
        print(f"Failed to open image {image_path}: {e}")
        return None, {}

    try:
        model_path = str(Path(__file__).parent / 'pose_landmarker_heavy.task')
        base_options = mp_python.BaseOptions(model_asset_path=model_path)
        options = vision.PoseLandmarkerOptions(
            base_options=base_options,
            output_segmentation_masks=False)

        with vision.PoseLandmarker.create_from_options(options) as landmarker:
            # MediaPipe requires numpy array in RGB format
            img_np = np.array(image)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=img_np)
            results = landmarker.detect(mp_image)

            if not results.pose_landmarks or len(results.pose_landmarks) == 0:
                return image, {}

            landmarks_list = results.pose_landmarks[0]

            # Blur face on a copy
            image_blurred = _blur_face(image.copy(), landmarks_list, img_width, img_height)

            # Create a drawing context
            draw = ImageDraw.Draw(image_blurred)

            if view_type in ["frontal", "back"]:
                measurements = _annotate_frontal(image_blurred, draw, landmarks_list, img_width, img_height, is_back=(view_type == "back"))
            elif view_type == "left_side":
                measurements = _annotate_side(image_blurred, draw, landmarks_list, img_width, img_height, is_right_side=False)
            elif view_type == "right_side":
                measurements = _annotate_side(image_blurred, draw, landmarks_list, img_width, img_height, is_right_side=True)
            else:
                measurements = {}

            return image_blurred, measurements

    except Exception as e:
        print(f"Error processing posture annotations: {e}")
        import traceback
        traceback.print_exc()
        return image, {}
