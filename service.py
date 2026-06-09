#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""PDF report generation and Telegram delivery helpers for posture analysis."""

import json
import base64
import subprocess
from pathlib import Path
from datetime import datetime
from io import BytesIO

import posture_annotator

try:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import cm, mm
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Image, Table, TableStyle, PageBreak
    from reportlab.lib.enums import TA_CENTER, TA_LEFT
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.lib import colors
    from PIL import Image as PILImage
    _HAS_REPORTLAB = True
except Exception:
    _HAS_REPORTLAB = False


def _register_font_by_name(font_name: str):
    """Register a font by asking fontconfig for the backing file.

    Returns the actual registered font name on success (may be an alias), or
    `None` on failure.
    """
    try:
        result = subprocess.run(
            ["fc-match", "-f", "%{file}\n", font_name],
            capture_output=True,
            text=True,
            check=True,
        )
        font_path = result.stdout.strip().splitlines()[0].strip()
        if not font_path:
            return None

        # Try to register using the requested family name first
        try:
            pdfmetrics.registerFont(TTFont(font_name, font_path))
            print(f"[fonts] registered font '{font_name}' -> {font_path}")
            return font_name
        except Exception as e:
            # Try an alias based on the filename in case the family name collides
            try:
                alias = f"{font_name}_{Path(font_path).stem}"
                pdfmetrics.registerFont(TTFont(alias, font_path))
                print(f"[fonts] registered font alias '{alias}' -> {font_path}")
                return alias
            except Exception as e2:
                print(f"[fonts] failed to register {font_path} for {font_name}: {e}; alias error: {e2}")
                return None
    except Exception:
        return None


def get_cyrillic_fonts():
    """Return a dict with 'regular' and 'bold' font names to use in PDFs.

    Prefer local project fonts in `fonts/` if present; otherwise try system
    font families via `_register_font_by_name`. Final fallback is
    ReportLab's `Helvetica`.
    """
    base_dir = Path(__file__).resolve().parent
    fonts_dir = base_dir / 'fonts'

    regular_local = fonts_dir / 'DejaVuSans.ttf'
    bold_local = fonts_dir / 'DejaVuSans-Bold.ttf'

    if regular_local.exists():
        try:
            pdfmetrics.registerFont(TTFont('DejaVuSansLocal', str(regular_local)))
            reg = 'DejaVuSansLocal'
            if bold_local.exists():
                try:
                    pdfmetrics.registerFont(TTFont('DejaVuSansLocal-Bold', str(bold_local)))
                    bold = 'DejaVuSansLocal-Bold'
                except Exception:
                    bold = reg
            else:
                bold = reg
            print(f"[fonts] using local fonts: regular={regular_local}, bold={bold_local if bold_local.exists() else 'n/a'}")
            return {'regular': reg, 'bold': bold}
        except Exception as e:
            print(f"[fonts] failed to register local fonts: {e}")

    # Try system fonts
    preferred_fonts = [
        "DejaVu Sans",
        "Liberation Sans",
        "Liberation Serif",
        "Arial",
        "Times New Roman",
    ]
    for fam in preferred_fonts:
        reg = _register_font_by_name(fam)
        if reg:
            bold = _register_font_by_name(fam + ' Bold') or reg
            return {'regular': reg, 'bold': bold}

    return {'regular': 'Helvetica', 'bold': 'Helvetica'}


def resize_image_maintain_aspect(image_or_path, max_width_mm, max_height_mm):
    """
    Resize image while maintaining aspect ratio.
    Returns BytesIO with resized image.
    """
    if isinstance(image_or_path, (str, Path)):
        img = PILImage.open(image_or_path)
    else:
        img = image_or_path
        
    original_width, original_height = img.size
    
    # Convert mm to pixels (approximately 11.81 pixels per mm at 300 DPI)
    max_width_px = int(max_width_mm * 11.81)
    max_height_px = int(max_height_mm * 11.81)
    
    # Calculate aspect ratio
    aspect_ratio = original_width / original_height
    
    # Calculate new dimensions
    if aspect_ratio > (max_width_px / max_height_px):
        # Width is limiting factor
        new_width = max_width_px
        new_height = int(max_width_px / aspect_ratio)
    else:
        # Height is limiting factor
        new_height = max_height_px
        new_width = int(max_height_px * aspect_ratio)
    
    # Resize image
    img_resized = img.resize((new_width, new_height), PILImage.Resampling.LANCZOS)
    
    # Save to BytesIO and return
    output = BytesIO()
    img_resized.save(output, format='JPEG', quality=90)
    output.seek(0)
    return output, new_width, new_height


def generate_pdf_from_analysis(user_id, timestamp, output_filename=None):
    """
    Generate a PDF report from saved analysis files using ReportLab.
    """
    base_dir = Path(__file__).resolve().parent
    received_photos_dir = base_dir / 'received_photos'
    results_dir = base_dir / 'results'
    
    # Read the data file
    data_file = received_photos_dir / f'{user_id}_{timestamp}_data.txt'
    if not data_file.exists():
        raise FileNotFoundError(f"Data file not found: {data_file}")
    
    # Read patient data
    patient_data = {}
    with open(data_file, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if ':' in line:
                key, value = line.split(':', 1)
                patient_data[key.strip()] = value.strip()
    
    # Read the analysis file
    analysis_file = results_dir / f'{user_id}_{timestamp}_analysis.json'
    if not analysis_file.exists():
        raise FileNotFoundError(f"Analysis file not found: {analysis_file}")
    
    with open(analysis_file, 'r', encoding='utf-8') as f:
        analysis = json.load(f)

    data_count = 3
    helper_photo = received_photos_dir / f'{user_id}_{timestamp}_photo_4.jpg'
    if helper_photo.exists():
        data_count = 4
    
    # Create output filename if not specified
    if output_filename is None:
        output_filename = results_dir / f'{user_id}_{timestamp}_report.pdf'
    
    if not _HAS_REPORTLAB:
        raise RuntimeError('reportlab/PIL not available in test environment')

    # Get Cyrillic fonts (regular and bold)
    fonts = get_cyrillic_fonts()
    regular_font = fonts.get('regular', 'Helvetica')
    bold_font = fonts.get('bold', regular_font)
    
    # Create PDF
    pdf = SimpleDocTemplate(str(output_filename), pagesize=A4,
                            rightMargin=15*mm, leftMargin=15*mm,
                            topMargin=15*mm, bottomMargin=15*mm)
    
    story: list = []
    
    # Define styles
    styles = getSampleStyleSheet()
    
    # Title style
    title_style = ParagraphStyle(
        'CustomTitle',
        parent=styles['Heading1'],
        fontSize=24,
        textColor=colors.HexColor('#1f4788'),
        spaceAfter=6,
        alignment=TA_CENTER,
        fontName=bold_font,
        wordWrap='CJK'
    )
    
    # Heading style
    heading_style = ParagraphStyle(
        'CustomHeading',
        parent=styles['Heading2'],
        fontSize=14,
        textColor=colors.HexColor('#2a5ccc'),
        spaceAfter=10,
        spaceBefore=10,
        fontName=bold_font,
        wordWrap='CJK'
    )
    
    # Body text style with Cyrillic support
    body_style = ParagraphStyle(
        'CustomBody',
        parent=styles['BodyText'],
        fontSize=10,
        textColor=colors.black,
        fontName=regular_font,
        wordWrap='CJK',
        leading=12
    )
    
    # Add title
    story.append(Paragraph("Отчет анализа осанки", title_style))
    story.append(Paragraph(f"Дата: {datetime.now().strftime('%d.%m.%Y %H:%M')}", 
                           ParagraphStyle('date', parent=styles['Normal'], 
                                        fontSize=9, textColor=colors.grey, 
                                        alignment=TA_CENTER, fontName=regular_font,
                                        wordWrap='CJK')))
    story.append(Spacer(1, 0.5*cm))
    
    # Patient Information Section
    story.append(Paragraph("Информация о пациенте", heading_style))
    
    patient_info_data = [
        ["ID пациента", patient_data.get('User ID', 'N/A')],
        ["Возраст", patient_data.get('Age', 'N/A')],
        ["Пол", patient_data.get('Gender', 'N/A')],
        ["Рост (см)", patient_data.get('Height', 'N/A')],
        ["Вес (кг)", patient_data.get('Weight', 'N/A')],
    ]
    
    patient_table = Table(patient_info_data, colWidths=[3*cm, 12*cm])
    patient_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (0, -1), colors.HexColor('#f5f5f5')),
        ('TEXTCOLOR', (0, 0), (-1, -1), colors.black),
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ('FONTNAME', (0, 0), (-1, -1), regular_font),
        ('FONTSIZE', (0, 0), (-1, -1), 10),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('GRID', (0, 0), (-1, -1), 1, colors.grey),
    ]))
    story.append(patient_table)
    story.append(Spacer(1, 0.5*cm))
    
    # Photos Section
    story.append(Paragraph("Фотографии анализа", heading_style))
    
    photo_paths = [
        received_photos_dir / f'{user_id}_{timestamp}_photo_1.jpg',
        received_photos_dir / f'{user_id}_{timestamp}_photo_2.jpg',
        received_photos_dir / f'{user_id}_{timestamp}_photo_3.jpg',
    ]
    photo_labels = ["Фронтальный вид", "Профиль справа", "Профиль слева"]
    view_types = ["frontal", "right_side", "left_side"]
    if data_count >= 4:
        photo_paths.append(helper_photo)
        photo_labels.append("Вид со спины")
        view_types.append("back")
    
    photos_data = []
    all_measurements = {}
    for photo_path, label, vtype in zip(photo_paths, photo_labels, view_types):
        if photo_path.exists():
            try:
                annotated_img, measurements = posture_annotator.process_photo(str(photo_path), vtype)
                if annotated_img is None:
                    annotated_img = PILImage.open(photo_path)
                    
                if measurements:
                    all_measurements[label] = measurements

                # Resize image maintaining aspect ratio and quality (enlarged for max 2 per row)
                img_io, new_w_px, new_h_px = resize_image_maintain_aspect(annotated_img, 75, 133)
                
                # Calculate physical dimensions for PDF based on 300 DPI (11.81 px/mm)
                pdf_w_mm = new_w_px / 11.81
                pdf_h_mm = new_h_px / 11.81
                img = Image(img_io, width=pdf_w_mm*mm, height=pdf_h_mm*mm)
                
                # Create cell with image and label
                img_with_label = f"<br/><br/>{label}"
                photos_data.append([img, Paragraph(img_with_label, 
                                                  ParagraphStyle('photo_label', 
                                                               parent=styles['Normal'],
                                                               fontSize=8,
                                                               alignment=TA_CENTER,
                                                               fontName=regular_font,
                                                               wordWrap='CJK'))])
            except Exception as e:
                print(f"Error processing photo {photo_path}: {e}")
                photos_data.append([Paragraph(f"Ошибка фото", body_style)])
        else:
            photos_data.append([Paragraph(f"Фото не найдено", body_style)])
    
    if photos_data:
        # Group photos into rows of 2
        rows_data = []
        for i in range(0, len(photos_data), 2):
            rows_data.append(photos_data[i:i+2])
            
        for row in rows_data:
            col_count = len(row)
            # Each cell gets 8.5cm. If 1 cell, table width is 8.5cm and centered on page.
            photos_table = Table([row], colWidths=[8.5 * cm for _ in range(col_count)])
            photos_table.setStyle(TableStyle([
                ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
                ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                ('LEFTPADDING', (0, 0), (-1, -1), 5),
                ('RIGHTPADDING', (0, 0), (-1, -1), 5),
            ]))
            story.append(photos_table)
            story.append(Spacer(1, 0.3*cm))
    
    # Push everything else to the next page
    story.append(PageBreak())
    
    if all_measurements:
        story.append(Paragraph("Измерения осанки", heading_style))
        meas_data = [["Ракурс", "Параметр", "Значение", "Оценка"]]
        for label, meas in all_measurements.items():
            if 'shoulder_angle' in meas:
                val = meas['shoulder_angle']
                eval_str = "Норма" if abs(val) < 2 else "Незнач. асимметрия" if abs(val) < 5 else "Асимметрия"
                meas_data.append([label, "Наклон плеч", f"{val:+.1f}°", eval_str])
            if 'hip_angle' in meas:
                val = meas['hip_angle']
                eval_str = "Норма" if abs(val) < 2 else "Незнач. асимметрия" if abs(val) < 5 else "Асимметрия"
                meas_data.append([label, "Наклон таза", f"{val:+.1f}°", eval_str])
            if 'forward_head_angle' in meas:
                val = meas['forward_head_angle']
                meas_data.append([label, "Смещение головы", f"{val:+.0f}°", "Информативно"])
            if 'shoulder_hip_angle' in meas:
                val = meas['shoulder_hip_angle']
                meas_data.append([label, "Наклон плеч-таза", f"{val:+.0f}°", "Информативно"])
                
        if len(meas_data) > 1:
            meas_table = Table(meas_data, colWidths=[4*cm, 4*cm, 2.5*cm, 4.5*cm])
            meas_table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#f5f5f5')),
                ('TEXTCOLOR', (0, 0), (-1, -1), colors.black),
                ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
                ('FONTNAME', (0, 0), (-1, -1), regular_font),
                ('FONTSIZE', (0, 0), (-1, -1), 9),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
                ('TOPPADDING', (0, 0), (-1, -1), 4),
                ('GRID', (0, 0), (-1, -1), 1, colors.grey),
            ]))
            story.append(meas_table)
            story.append(Spacer(1, 0.5*cm))
    
    # Summary Section
    story.append(Paragraph("Резюме анализа", heading_style))
    summary = analysis.get('summary', '')
    story.append(Paragraph(summary, body_style))
    story.append(Spacer(1, 0.3*cm))
    
    # Observations Section
    story.append(Paragraph("Детальные наблюдения", heading_style))
    
    observations = analysis.get('observations', {})
    obs_labels = {
        'head': 'Голова',
        'shoulders': 'Плечи',
        'pelvis': 'Таз',
        'spine': 'Позвоночник',
        'legs': 'Ноги'
    }
    
    for obs_key, obs_value in observations.items():
        label = obs_labels.get(obs_key, obs_key.capitalize())
        story.append(Paragraph(f"<b>{label}:</b>", 
                              ParagraphStyle('obs_title', parent=styles['Normal'],
                                           fontSize=10, fontName=bold_font,
                                           textColor=colors.HexColor('#1f4788'),
                                           wordWrap='CJK')))
        story.append(Paragraph(obs_value, body_style))
        story.append(Spacer(1, 0.2*cm))
    
    story.append(Spacer(1, 0.3*cm))
    
    # Exercises Section
    story.append(PageBreak())
    story.append(Paragraph("Рекомендуемые упражнения", heading_style))
    
    exercises = analysis.get('recommended_exercises', [])
    for idx, exercise in enumerate(exercises, 1):
        exercise_name = exercise.get('name', 'N/A')
        exercise_reason = exercise.get('reason', 'N/A')
        
        story.append(Paragraph(f"<b>{idx}. {exercise_name}</b>", 
                              ParagraphStyle('ex_title', parent=styles['Normal'],
                                           fontSize=10, fontName=bold_font,
                                           textColor=colors.HexColor('#1f4788'),
                                           wordWrap='CJK')))
        story.append(Paragraph(f"<i>{exercise_reason}</i>", 
                              ParagraphStyle('ex_reason', parent=styles['Normal'],
                                           fontSize=9, fontName=regular_font,
                                           textColor=colors.HexColor('#555555'),
                                           leftIndent=10,
                                           wordWrap='CJK')))
        story.append(Spacer(1, 0.2*cm))
    
    story.append(Spacer(1, 0.5*cm))
    
    # Disclaimer
    disclaimer = analysis.get('disclaimer', '')
    story.append(Paragraph("<b>⚠️  Важное предупреждение:</b>", 
                          ParagraphStyle('disclaimer_title', parent=styles['Normal'],
                                       fontSize=10, fontName=bold_font,
                                       textColor=colors.HexColor('#ff6600'),
                                       wordWrap='CJK')))
    story.append(Paragraph(disclaimer, 
                          ParagraphStyle('disclaimer', parent=styles['Normal'],
                                       fontSize=9, fontName=regular_font,
                                       textColor=colors.HexColor('#333333'),
                                       wordWrap='CJK')))
    
    story.append(Spacer(1, 0.5*cm))
    
    # Footer
    model_used = analysis.get('model_used', 'unknown')
    story.append(Paragraph(f"Модель: {model_used}", 
                          ParagraphStyle('footer', parent=styles['Normal'],
                                       fontSize=8, fontName=regular_font,
                                       textColor=colors.grey,
                                       alignment=TA_CENTER,
                                       wordWrap='CJK')))
    
    # Build PDF
    pdf.build(story)
    
    return str(output_filename)


def deliver_pdf_to_telegram(pdf_path, user_id):
    """Try to send the generated PDF to the Telegram chat represented by user_id.

    Returns True on success, False otherwise.
    """
    try:
        import bot as telegram_bot
    except Exception:
        return False

    try:
        chat_id = int(user_id)
    except Exception:
        return False

    try:
        with open(pdf_path, 'rb') as doc:
            telegram_bot.bot.send_document(chat_id, doc)
        return True
    except Exception:
        return False


if __name__ == "__main__":
    import sys
    
    if len(sys.argv) < 2:
        print("Использование: python service.py <user_id> <timestamp> [output_file]")
        print("Пример: python service.py 6363039972 20260514_200943")
        sys.exit(1)
    
    user_id = sys.argv[1]
    timestamp = sys.argv[2]
    output_file = sys.argv[3] if len(sys.argv) > 3 else None
    
    try:
        result = generate_pdf_from_analysis(user_id, timestamp, output_file)
        print(f"Отчет успешно создан: {result}")
    except Exception as e:
        print(f"Ошибка: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
