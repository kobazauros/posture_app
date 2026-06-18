import os

with open('server.py', 'a', encoding='utf-8') as f:
    f.write('''\n\n# --- SPECIALIST CABINET ROUTES ---\n\n''')
    
    f.write('''@app.route('/specialist')
def specialist_dashboard():
    \"\"\"Serves the specialist dashboard HTML page.\"\"\"
    user = check_auth(request)
    if not user or user.get('role') not in ['admin', 'specialist']:
        return redirect('/auth_page')
    return send_from_directory('.', 'specialist.html')
\n''')

    f.write('''@app.route('/api/specialist/clients', methods=['GET'])
def api_specialist_clients():
    user = check_auth(request)
    if not user or user.get('role') not in ['admin', 'specialist']:
        return jsonify({'error': 'Unauthorized'}), 401
        
    query = request.args.get('query', '')
    limit = int(request.args.get('limit', 20))
    offset = int(request.args.get('offset', 0))
    
    specialist_id = user['id']
    clients = database.search_specialist_clients(specialist_id, query, limit, offset)
    return jsonify({'clients': clients})
\n''')

    f.write('''@app.route('/api/specialist/pool', methods=['GET'])
def api_specialist_pool():
    user = check_auth(request)
    if not user or user.get('role') not in ['admin', 'specialist']:
        return jsonify({'error': 'Unauthorized'}), 401
        
    limit = int(request.args.get('limit', 20))
    offset = int(request.args.get('offset', 0))
    
    pool = database.get_premium_pool(limit, offset)
    return jsonify({'pool': pool})
\n''')

    f.write('''@app.route('/api/specialist/analyses/<int:analysis_id>/assign', methods=['POST'])
def api_assign_analysis(analysis_id):
    user = check_auth(request)
    if not user or user.get('role') not in ['admin', 'specialist']:
        return jsonify({'error': 'Unauthorized'}), 401
        
    success = database.assign_analysis(analysis_id, user['id'])
    if success:
        return jsonify({'success': True})
    return jsonify({'error': 'Failed to assign analysis'}), 500
\n''')

    f.write('''@app.route('/api/specialist/analyses/<int:analysis_id>/recommendations', methods=['PUT'])
def api_update_recommendations(analysis_id):
    user = check_auth(request)
    if not user or user.get('role') not in ['admin', 'specialist']:
        return jsonify({'error': 'Unauthorized'}), 401
        
    data = request.json
    if not data or 'recommendations' not in data:
        return jsonify({'error': 'Missing recommendations'}), 400
        
    success = database.update_recommendations(analysis_id, data['recommendations'])
    if success:
        return jsonify({'success': True})
    return jsonify({'error': 'Failed to update recommendations'}), 500
\n''')
