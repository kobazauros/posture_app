import cv2
import numpy as np
from PIL import Image, ExifTags
import json
import re

def correct_image_perspective(img, pitch_deg, roll_deg, K):
    """
    Применяет гомографию (Perspective Transform) к изображению,
    чтобы "выровнять" его, компенсируя наклон камеры (pitch) и крен (roll).
    Возвращает выровненное изображение.
    """
    h, w = img.shape[:2]
    
    # Ограничиваем углы, чтобы избежать экстремальных искажений
    pitch_deg = max(-30, min(30, pitch_deg))
    roll_deg = max(-30, min(30, roll_deg))
    
    pitch_rad = np.radians(pitch_deg)
    roll_rad = np.radians(roll_deg)
    
    # Строим матрицу вращения
    R_x = np.array([
        [1, 0, 0],
        [0, np.cos(pitch_rad), -np.sin(pitch_rad)],
        [0, np.sin(pitch_rad), np.cos(pitch_rad)]
    ], dtype=np.float32)
    
    R_z = np.array([
        [np.cos(roll_rad), -np.sin(roll_rad), 0],
        [np.sin(roll_rad), np.cos(roll_rad), 0],
        [0, 0, 1]
    ], dtype=np.float32)
    
    R = R_z @ R_x
    
    # Гомография чистого вращения камеры: H = K * R^(-1) * K^(-1)
    K_inv = np.linalg.inv(K)
    R_inv = np.linalg.inv(R)
    H = K @ R_inv @ K_inv
    
    # Корректируем смещение, чтобы центр изображения оставался в центре
    center = np.array([[w / 2.0], [h / 2.0], [1.0]])
    center_warped = H @ center
    center_warped /= center_warped[2]
    
    T = np.array([
        [1, 0, w / 2.0 - center_warped[0, 0]],
        [0, 1, h / 2.0 - center_warped[1, 0]],
        [0, 0, 1]
    ], dtype=np.float32)
    
    H = T @ H
    
    # Применяем трансформацию к изображению
    # Используем INTER_CUBIC для лучшего качества
    corrected_img = cv2.warpPerspective(img, H, (w, h), flags=cv2.INTER_CUBIC)
    
    return corrected_img

def get_camera_matrix(width, height, focal_35mm=26.0):
    """
    Вычисляет матрицу камеры (K) и фокусное расстояние в пикселях 
    на основе эквивалентного фокусного расстояния (по умолчанию 26 мм).
    """
    # Вычисляем фокусное расстояние в пикселях
    # Диагональ / ширина полного кадра ~ 36мм (если ориентация горизонтальная) или 24мм (если вертикальная)
    sensor_width_mm = 36.0 if width >= height else 24.0
    f_px = (focal_35mm / sensor_width_mm) * max(width, height)
    
    # Создаем матрицу камеры
    K = np.array([
        [f_px, 0, width / 2.0],
        [0, f_px, height / 2.0],
        [0, 0, 1]
    ], dtype=np.float32)
    
    return f_px, K

def get_orientation_from_exif(image_path):
    """
    Пытается извлечь Pitch (наклон вверх/вниз) и Roll (наклон влево/вправо) из EXIF.
    1. Ищет в стандартном EXIF UserComment (JSON вида {"pitch": 10, "roll": 0}).
    2. Ищет в XMP метаданных (формат XML, который используют Google Camera, дроны и т.д.).
    Возвращает pitch, roll в градусах, или None, None.
    """
    pitch, roll = None, None
    
    # 1. Проверяем EXIF UserComment
    try:
        img = Image.open(image_path)
        exif = img.getexif()
        if exif:
            for tag_id, value in exif.items():
                tag = ExifTags.TAGS.get(tag_id, tag_id)
                if tag == 'UserComment':
                    if isinstance(value, bytes):
                        # Убираем префикс кодировки (обычно 8 байт, например ASCII\0\0\0)
                        value = value[8:].decode('utf-8', errors='ignore').strip()
                    try:
                        # Пытаемся распарсить как JSON
                        data = json.loads(value)
                        if 'pitch' in data: pitch = float(data['pitch'])
                        if 'roll' in data: roll = float(data['roll'])
                    except:
                        pass
    except Exception as e:
        print(f"  EXIF: Ошибка чтения UserComment: {e}")

    # 2. Ищем в сырых XMP данных (XML внутри JPEG)
    if pitch is None or roll is None:
        try:
            with open(image_path, 'rb') as f:
                content = f.read()
                # Регулярки для поиска Pitch и Roll в различных XMP форматах
                pitch_match = re.search(rb'(?:CameraPitch|DevicePitch|GimbalPitchDegree|Pitch)="?([-\d.]+)"?', content, re.IGNORECASE)
                roll_match = re.search(rb'(?:CameraRoll|DeviceRoll|GimbalRollDegree|Roll)="?([-\d.]+)"?', content, re.IGNORECASE)
                
                if pitch_match and pitch is None:
                    pitch = float(pitch_match.group(1))
                if roll_match and roll is None:
                    roll = float(roll_match.group(1))
        except Exception as e:
            print(f"  EXIF: Ошибка чтения XMP: {e}")

    if pitch is not None and roll is not None:
        print(f"  EXIF: Найдена ориентация: Pitch={pitch}°, Roll={roll}°")
        return pitch, roll
        
    return None, None

def solve_tvec_with_fixed_rvec(obj_points, img_points, K, rvec):
    """
    Аналитически находит вектор трансляции (tvec) при жестко заданном векторе вращения (rvec).
    Решает переопределенную систему линейных уравнений методом наименьших квадратов.
    """
    R, _ = cv2.Rodrigues(rvec)
    K_inv = np.linalg.inv(K)
    
    A = []
    B = []
    
    for i in range(len(obj_points)):
        # 3D точка в координатах камеры до сдвига
        p_prime = R @ obj_points[i].reshape(3, 1)
        px, py, pz = p_prime[0, 0], p_prime[1, 0], p_prime[2, 0]
        
        # Направление луча в пространстве камеры
        uv1 = np.array([[img_points[i][0]], [img_points[i][1]], [1.0]])
        v = K_inv @ uv1
        vx, vy = v[0, 0], v[1, 0]
        
        # Формируем матрицу уравнений для tvec = [tx, ty, tz]^T
        # vx * (pz + tz) - tx = px  =>  -tx + vx * tz = px - vx * pz
        # vy * (pz + tz) - ty = py  =>  -ty + vy * tz = py - vy * pz
        A.append([-1,  0, vx])
        A.append([ 0, -1, vy])
        
        B.append(px - vx * pz)
        B.append(py - vy * pz)
        
    A = np.array(A, dtype=np.float32)
    B = np.array(B, dtype=np.float32)
    
    # Решаем систему A * tvec = B
    tvec, _, _, _ = np.linalg.lstsq(A, B, rcond=None)
    return tvec.reshape(3, 1)

def get_height_from_mask(mask_path):
    """
    Определяет высоту силуэта в пикселях на основе SAM маски.
    """
    mask = cv2.imread(mask_path, cv2.IMREAD_GRAYSCALE)
    if mask is None:
        print(f"  Не удалось загрузить маску: {mask_path}")
        return None
        
    y_indices, x_indices = np.where(mask > 0)
    if len(y_indices) == 0:
        return None
        
    min_y = np.min(y_indices)
    max_y = np.max(y_indices)
    h_px = max_y - min_y
    return h_px

def estimate_perspective(f_px, K, mask_height_px, anny_joints_3d, mp_2d, bone_labels, real_height_m=1.88, pitch_deg=None, roll_deg=None):
    """
    Решает задачу PnP для оценки наклона и положения камеры.
    Если заданы pitch_deg и roll_deg, фиксирует матрицу вращения и рассчитывает только сдвиг.
    """
    # 1. Считаем грубую дистанцию Z по маске
    Z = f_px * (real_height_m / mask_height_px)
    
    # 2. Формируем пары 3D -> 2D для алгоритма PnP
    # Берем больше надежных костей, чтобы PnP не ошибался с точкой схода
    target_bones = [
        "head", "neck01", "spine01", "spine02", "pelvis",
        "upperarm01.L", "upperarm01.R", 
        "lowerarm01.L", "lowerarm01.R", 
        "wrist.L", "wrist.R",
        "upperleg01.L", "upperleg01.R",
        "lowerleg01.L", "lowerleg01.R",
        "foot.L", "foot.R"
    ]
    
    obj_points = []
    img_points = []
    
    for bone in target_bones:
        if bone in mp_2d and bone in bone_labels:
            idx = bone_labels.index(bone)
            pt_3d = anny_joints_3d[idx] 
            
            # Конвертация координат Anny -> OpenCV
            # Anny: X (влево), Y (глубина вперед), Z (высота вверх)
            # OpenCV: X (вправо), Y (вниз), Z (глубина вдаль)
            x_cv = -pt_3d[0]
            y_cv = -pt_3d[2]
            z_cv = -pt_3d[1]
            
            obj_points.append([x_cv, y_cv, z_cv])
            img_points.append(mp_2d[bone])
            
    if len(obj_points) < 4:
        print("  PnP: Недостаточно точек для оценки перспективы (нужно минимум 4).")
        return None, None, None
        
    obj_points = np.array(obj_points, dtype=np.float32)
    img_points = np.array(img_points, dtype=np.float32)
    
    if pitch_deg is not None and roll_deg is not None:
        # Если углы известны, создаем жесткий rvec
        pitch_rad = np.radians(pitch_deg)
        roll_rad = np.radians(roll_deg)
        
        # В OpenCV оси: X вправо, Y вниз, Z от камеры.
        # pitch - поворот вокруг X. roll - вокруг Z.
        R_x = np.array([
            [1, 0, 0],
            [0, np.cos(pitch_rad), -np.sin(pitch_rad)],
            [0, np.sin(pitch_rad), np.cos(pitch_rad)]
        ], dtype=np.float32)
        
        R_z = np.array([
            [np.cos(roll_rad), -np.sin(roll_rad), 0],
            [np.sin(roll_rad), np.cos(roll_rad), 0],
            [0, 0, 1]
        ], dtype=np.float32)
        
        R = R_z @ R_x
        rvec, _ = cv2.Rodrigues(R)
        
        # Рассчитываем только tvec
        tvec = solve_tvec_with_fixed_rvec(obj_points, img_points, K, rvec)
        print("  PnP: Использована жесткая привязка перспективы по EXIF.")
        
    else:
        # Решаем PnP с помощью более стабильного алгоритма SQPNP (или EPNP)
        flags = cv2.SOLVEPNP_SQPNP if hasattr(cv2, 'SOLVEPNP_SQPNP') else cv2.SOLVEPNP_EPNP
        success, rvec, tvec = cv2.solvePnP(
            obj_points, img_points, K, None, flags=flags
        )
        
        if not success or np.isnan(rvec).any() or np.isnan(tvec).any():
            print("  PnP: SQPNP не удался, пробуем ITERATIVE.")
            # Задаем начальное приближение tvec с рассчитанной дистанцией Z
            rvec_init = np.zeros((3, 1), dtype=np.float32)
            tvec_init = np.array([[0.0], [0.0], [Z]], dtype=np.float32)
            success, rvec, tvec = cv2.solvePnP(
                obj_points, img_points, K, None, 
                rvec=rvec_init, tvec=tvec_init, 
                useExtrinsicGuess=True, flags=cv2.SOLVEPNP_ITERATIVE
            )
            
        if not success:
            print("  PnP: Ошибка при решении Perspective-n-Point.")
            return None, None, None
            
    # Ищем уровень пола (самая низкая точка стоп)
    idx_foot_l = bone_labels.index("foot.L")
    idx_foot_r = bone_labels.index("foot.R")
    floor_y_anny = min(anny_joints_3d[idx_foot_l][2], anny_joints_3d[idx_foot_r][2])
    floor_y_cv = -floor_y_anny
    
    return rvec, tvec, floor_y_cv

def draw_perspective_grid(img, rvec, tvec, K, floor_y_cv, grid_size=10, cell_size=0.5):
    """
    Рисует сетку пола, уходящую вдаль.
    :param grid_size: количество ячеек
    :param cell_size: размер ячейки в метрах
    """
    points_3d = []
    half_grid = grid_size * cell_size / 2.0
    
    # Формируем линии сетки
    for x in np.arange(-half_grid, half_grid + cell_size, cell_size):
        points_3d.append([x, floor_y_cv, -half_grid])
        points_3d.append([x, floor_y_cv, half_grid])
        
    for z in np.arange(-half_grid, half_grid + cell_size, cell_size):
        points_3d.append([-half_grid, floor_y_cv, z])
        points_3d.append([half_grid, floor_y_cv, z])
        
    points_3d = np.array(points_3d, dtype=np.float32)
    
    # Проецируем 3D сетку на 2D картинку
    points_2d, _ = cv2.projectPoints(points_3d, rvec, tvec, K, None)
    points_2d = points_2d.reshape(-1, 2)
    
    # Отрисовка серым цветом, как просил пользователь
    grid_color = (128, 128, 128)
    thickness = 1
    
    overlay = img.copy()
    num_lines = int(grid_size) + 1
    
    # Рисуем линии
    for i in range(num_lines * 2):
        pt1 = tuple(points_2d[i * 2].astype(int))
        pt2 = tuple(points_2d[i * 2 + 1].astype(int))
        # Проверка, чтобы точки не улетали за бесконечность (за спину камеры)
        if pt1[1] > -10000 and pt2[1] > -10000: 
            cv2.line(overlay, pt1, pt2, grid_color, thickness)
            
    # Полупрозрачное смешивание
    cv2.addWeighted(overlay, 0.5, img, 0.5, 0, img)
