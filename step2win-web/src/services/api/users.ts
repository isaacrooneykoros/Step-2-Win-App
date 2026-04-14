import api from './client';

export const usersService = {
  updateDailyGoal: async (goal: number): Promise<{ daily_goal: number; message: string }> => {
    const response = await api.patch('/api/auth/goal/', { daily_goal: goal });
    return response.data;
  },

  uploadProfilePicture: async (file: Blob): Promise<{ status: string; profile_picture_url: string; message: string }> => {
    const formData = new FormData();
    formData.append('profile_picture', file, 'profile_picture.jpg');
    
    const response = await api.post('/api/auth/profile/picture/upload/', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  },

  deleteProfilePicture: async (): Promise<{ status: string; message: string }> => {
    const response = await api.delete('/api/auth/profile/picture/delete/');
    return response.data;
  },

  getProfile: async () => {
    const response = await api.get('/api/auth/profile/');
    return response.data;
  },
};
