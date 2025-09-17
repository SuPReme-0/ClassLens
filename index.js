const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

// Initialize Express app and HTTP server
const app = express();
const server = http.createServer(app);

// Socket.IO setup for real-time communication
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' })); // For face scan data

// Supabase client initialization
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || ''
);

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

// Utility function to validate teacher ownership of class
async function validateTeacherClass(teacher_id, class_id) {
  try {
    const { data, error } = await supabase
      .from('classes')
      .select('id')
      .eq('id', class_id)
      .eq('teacher_id', teacher_id)
      .single();
    
    if (error) throw error;
    return !!data;
  } catch (error) {
    console.error('Class validation error:', error);
    return false;
  }
}

// Utility function to validate student enrollment
async function validateStudentEnrollment(student_id, class_id) {
  try {
    const { data, error } = await supabase
      .from('class_students')
      .select('class_id')
      .eq('class_id', class_id)
      .eq('student_id', student_id)
      .single();
    
    if (error) throw error;
    return !!data;
  } catch (error) {
    console.error('Enrollment validation error:', error);
    return false;
  }
}

// ===== API ROUTES =====

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'EduPresence Backend'
  });
});

// Generate BLE session token for attendance
app.post('/api/ble/session', async (req, res) => {
  try {
    const { class_id, teacher_id } = req.body;
    
    // Validate input
    if (!class_id || !teacher_id) {
      return res.status(400).json({ error: 'Missing class_id or teacher_id' });
    }
    
    // Verify teacher owns class
    const isValid = await validateTeacherClass(teacher_id, class_id);
    if (!isValid) {
      return res.status(403).json({ error: 'Unauthorized: Teacher does not own this class' });
    }
    
    // Get class details
    const { data: classData, error: classError } = await supabase
      .from('classes')
      .select('name')
      .eq('id', class_id)
      .single();
    
    if (classError) throw classError;
    
    // Generate session token (5 minutes expiration)
    const sessionToken = jwt.sign(
      { 
        class_id, 
        teacher_id, 
        timestamp: Date.now(),
        expires_at: Date.now() + 300000 // 5 minutes
      },
      JWT_SECRET
    );
    
    // Emit session start to all connected clients
    io.emit('attendance_session_started', {
      class_id,
      class_name: classData.name,
      teacher_id,
      session_token: sessionToken,
      timestamp: new Date().toISOString()
    });
    
    console.log(`Attendance session started for class: ${classData.name} (${class_id})`);
    
    res.json({ 
      success: true,
      session_token: sessionToken,
      message: 'Attendance session started successfully'
    });
  } catch (error) {
    console.error('Session creation error:', error);
    res.status(500).json({ error: 'Failed to create attendance session' });
  }
});

// Validate BLE session token
app.post('/api/ble/validate', async (req, res) => {
  try {
    const { session_token } = req.body;
    
    if (!session_token) {
      return res.status(400).json({ error: 'Missing session_token' });
    }
    
    // Verify and decode token
    const decoded = jwt.verify(session_token, JWT_SECRET);
    
    // Check if token has expired
    if (decoded.expires_at < Date.now()) {
      return res.status(401).json({ error: 'Session expired' });
    }
    
    // Get class details
    const { data: classData, error: classError } = await supabase
      .from('classes')
      .select('name')
      .eq('id', decoded.class_id)
      .single();
    
    if (classError) throw classError;
    
    res.json({ 
      valid: true, 
      class_id: decoded.class_id,
      class_name: classData.name,
      teacher_id: decoded.teacher_id
    });
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid session token' });
    }
    console.error('Session validation error:', error);
    res.status(500).json({ error: 'Failed to validate session' });
  }
});

// Mark attendance for student
app.post('/api/attendance/mark', async (req, res) => {
  try {
    const { class_id, student_id, rssi, face_scan_data } = req.body;
    
    // Validate input
    if (!class_id || !student_id) {
      return res.status(400).json({ error: 'Missing class_id or student_id' });
    }
    
    // Verify student is enrolled in class
    const isEnrolled = await validateStudentEnrollment(student_id, class_id);
    if (!isEnrolled) {
      return res.status(403).json({ error: 'Student not enrolled in this class' });
    }
    
    // Check if attendance already exists for today
    const today = new Date().toISOString().split('T')[0];
    const { data: existingAttendance, error: existingError } = await supabase
      .from('attendance')
      .select('id')
      .eq('class_id', class_id)
      .eq('student_id', student_id)
      .eq('date', today)
      .maybeSingle();
    
    if (existingError) throw existingError;
    
    if (existingAttendance) {
      return res.status(400).json({ error: 'Attendance already marked for today' });
    }
    
    // Insert attendance record
    const { data, error } = await supabase
      .from('attendance')
      .insert([
        {
          class_id,
          student_id,
          date: today,
          status: true,
          rssi: rssi || null,
          face_scan_data: face_scan_data || null
        }
      ])
      .select('*');
    
    if (error) throw error;
    
    // Emit attendance update
    io.emit('attendance_marked', {
      class_id,
      student_id,
      attendance: data[0],
      timestamp: new Date().toISOString()
    });
    
    console.log(`Attendance marked for student ${student_id} in class ${class_id}`);
    
    res.json({ 
      success: true, 
      attendance: data[0],
      message: 'Attendance marked successfully'
    });
  } catch (error) {
    console.error('Attendance marking error:', error);
    res.status(500).json({ error: 'Failed to mark attendance' });
  }
});

// Get class attendance records
app.get('/api/attendance/class/:class_id', async (req, res) => {
  try {
    const { class_id } = req.params;
    const { date } = req.query;
    
    if (!class_id) {
      return res.status(400).json({ error: 'Missing class_id' });
    }
    
    let query = supabase
      .from('attendance')
      .select(`
        id,
        date,
        status,
        rssi,
        created_at,
        users (id, name, enrollment_no)
      `)
      .eq('class_id', class_id)
      .order('date', { ascending: false });
    
    if (date) {
      query = query.eq('date', date);
    }
    
    const { data, error } = await query;
    
    if (error) throw error;
    
    res.json({ attendance: data });
  } catch (error) {
    console.error('Attendance fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch attendance records' });
  }
});

// Get student attendance records
app.get('/api/attendance/student/:student_id', async (req, res) => {
  try {
    const { student_id } = req.params;
    
    if (!student_id) {
      return res.status(400).json({ error: 'Missing student_id' });
    }
    
    const { data, error } = await supabase
      .from('attendance')
      .select(`
        id,
        date,
        status,
        rssi,
        created_at,
        classes (id, name)
      `)
      .eq('student_id', student_id)
      .order('date', { ascending: false });
    
    if (error) throw error;
    
    res.json({ attendance: data });
  } catch (error) {
    console.error('Student attendance fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch student attendance records' });
  }
});

// ===== SOCKET.IO HANDLERS =====

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  // Join a specific class room
  socket.on('join_class', (classId) => {
    if (classId) {
      socket.join(`class_${classId}`);
      console.log(`User ${socket.id} joined class ${classId}`);
    }
  });
  
  // Leave a specific class room
  socket.on('leave_class', (classId) => {
    if (classId) {
      socket.leave(`class_${classId}`);
      console.log(`User ${socket.id} left class ${classId}`);
    }
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Handle 404 errors
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`EduPresence Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
