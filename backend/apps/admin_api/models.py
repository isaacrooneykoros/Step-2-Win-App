from django.db import models


class SystemSettings(models.Model):
    """Platform-wide system settings - singleton model"""
    
    # Platform Fees
    platform_fee_percentage = models.DecimalField(
        max_digits=5, 
        decimal_places=2, 
        default=5.00,
        help_text="Platform fee percentage on challenge pools"
    )
    
    # Withdrawal Settings
    minimum_withdrawal_amount = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=10.00,
        help_text="Minimum amount users can withdraw"
    )
    withdrawal_processing_time = models.IntegerField(
        default=24,
        help_text="Expected withdrawal processing time in hours"
    )
    
    # Challenge Settings
    min_challenge_entry_fee = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=1.00,
        help_text="Minimum entry fee for challenges"
    )
    max_challenge_entry_fee = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=1000.00,
        help_text="Maximum entry fee for challenges"
    )
    min_challenge_milestone = models.IntegerField(
        default=1000,
        help_text="Minimum steps milestone for challenges"
    )
    max_challenge_milestone = models.IntegerField(
        default=100000,
        help_text="Maximum steps milestone for challenges"
    )
    max_challenge_participants = models.IntegerField(
        default=100,
        help_text="Maximum participants per challenge"
    )
    challenge_approval_required = models.BooleanField(
        default=True,
        help_text="Whether challenges require admin approval"
    )
    
    # Feature Toggles
    registrations_enabled = models.BooleanField(
        default=True,
        help_text="Allow new user registrations"
    )
    challenges_enabled = models.BooleanField(
        default=True,
        help_text="Allow challenge creation"
    )
    withdrawals_enabled = models.BooleanField(
        default=True,
        help_text="Allow withdrawal requests"
    )
    referral_program_enabled = models.BooleanField(
        default=True,
        help_text="Enable referral program"
    )
    
    # Gamification Settings
    xp_per_step = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        default=0.10,
        help_text="XP awarded per step taken"
    )
    daily_goal_bonus_xp = models.IntegerField(
        default=100,
        help_text="Bonus XP for reaching daily step goal"
    )
    
    # Notifications
    admin_email = models.EmailField(
        default='admin@step2win.com',
        help_text="Admin contact email"
    )
    support_email = models.EmailField(
        default='support@step2win.com',
        help_text="Support contact email"
    )
    email_notifications_enabled = models.BooleanField(
        default=True,
        help_text="Enable email notifications"
    )
    
    # Maintenance
    maintenance_mode = models.BooleanField(
        default=False,
        help_text="Enable maintenance mode (blocks all user access)"
    )
    maintenance_message = models.TextField(
        blank=True,
        help_text="Message to display during maintenance"
    )
    
    # Metadata
    updated_at = models.DateTimeField(auto_now=True)
    updated_by = models.ForeignKey(
        'users.User',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='settings_updates'
    )
    
    class Meta:
        verbose_name = 'System Settings'
        verbose_name_plural = 'System Settings'
    
    def save(self, *args, **kwargs):
        """Ensure only one instance exists (singleton pattern)"""
        self.pk = 1
        super().save(*args, **kwargs)
    
    def delete(self, *args, **kwargs):
        """Prevent deletion"""
        pass
    
    @classmethod
    def load(cls):
        """Load the singleton instance, create if doesn't exist"""
        obj, created = cls.objects.get_or_create(pk=1)
        return obj
    
    def __str__(self):
        return f"System Settings (updated {self.updated_at})"


class AuditLog(models.Model):
    """Activity log for tracking admin actions"""
    
    ACTION_CHOICES = [
        ('create', 'Create'),
        ('update', 'Update'),
        ('delete', 'Delete'),
        ('login', 'Login'),
        ('logout', 'Logout'),
        ('ban', 'Ban'),
        ('unban', 'Unban'),
        ('approve', 'Approve'),
        ('reject', 'Reject'),
        ('cancel', 'Cancel'),
        ('promote', 'Promote'),
        ('demote', 'Demote'),
        ('reset_password', 'Reset Password'),
        ('settings_change', 'Settings Change'),
    ]
    
    RESOURCE_CHOICES = [
        ('user', 'User'),
        ('challenge', 'Challenge'),
        ('transaction', 'Transaction'),
        ('withdrawal', 'Withdrawal'),
        ('badge', 'Badge'),
        ('settings', 'System Settings'),
        ('support', 'Support'),
        ('auth', 'Authentication'),
    ]
    
    # Who performed the action
    admin = models.ForeignKey(
        'users.User',
        on_delete=models.SET_NULL,
        null=True,
        related_name='admin_actions'
    )
    admin_username = models.CharField(max_length=150)  # Store username in case user is deleted
    
    # What was done
    action = models.CharField(max_length=50, choices=ACTION_CHOICES)
    resource_type = models.CharField(max_length=50, choices=RESOURCE_CHOICES)
    resource_id = models.IntegerField(null=True, blank=True)
    resource_name = models.CharField(max_length=255, blank=True)
    
    # Details
    description = models.TextField()
    changes = models.JSONField(null=True, blank=True)  # Before/after data
    
    # Context
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=500, blank=True)
    
    # Timestamp
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    
    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['-created_at']),
            models.Index(fields=['admin', '-created_at']),
            models.Index(fields=['resource_type', '-created_at']),
            models.Index(fields=['action', '-created_at']),
        ]
    
    def __str__(self):
        return f"{self.admin_username} - {self.action} {self.resource_type} at {self.created_at}"
    
    @classmethod
    def log_action(cls, admin, action, resource_type, description, resource_id=None, resource_name='', changes=None, request=None):
        """Helper method to create audit log entries"""
        ip_address = None
        user_agent = ''
        
        if request:
            # Get IP address
            x_forwarded_for = request.META.get('HTTP_X_FORWARDED_FOR')
            if x_forwarded_for:
                ip_address = x_forwarded_for.split(',')[0]
            else:
                ip_address = request.META.get('REMOTE_ADDR')
            
            # Get user agent
            user_agent = request.META.get('HTTP_USER_AGENT', '')[:500]
        
        return cls.objects.create(
            admin=admin,
            admin_username=admin.username if admin else 'System',
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            resource_name=resource_name,
            description=description,
            changes=changes,
            ip_address=ip_address,
            user_agent=user_agent,
        )


class SupportTicket(models.Model):
    """Support ticket raised by a user and managed by admins"""

    STATUS_CHOICES = [
        ('open', 'Open'),
        ('in_progress', 'In Progress'),
        ('resolved', 'Resolved'),
        ('closed', 'Closed'),
    ]

    PRIORITY_CHOICES = [
        ('low', 'Low'),
        ('medium', 'Medium'),
        ('high', 'High'),
        ('urgent', 'Urgent'),
    ]

    CATEGORY_CHOICES = [
        ('general', 'General'),
        ('account', 'Account'),
        ('challenge', 'Challenge'),
        ('payment', 'Payment'),
        ('technical', 'Technical'),
        ('other', 'Other'),
    ]

    user = models.ForeignKey(
        'users.User',
        on_delete=models.CASCADE,
        related_name='support_tickets'
    )
    subject = models.CharField(max_length=255)
    category = models.CharField(max_length=50, choices=CATEGORY_CHOICES, default='general')
    message = models.TextField()
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='open')
    priority = models.CharField(max_length=20, choices=PRIORITY_CHOICES, default='medium')
    assigned_to = models.ForeignKey(
        'users.User',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='assigned_support_tickets'
    )
    admin_notes = models.TextField(blank=True)
    resolved_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-updated_at']
        indexes = [
            models.Index(fields=['status', '-updated_at']),
            models.Index(fields=['priority', '-updated_at']),
            models.Index(fields=['assigned_to', '-updated_at']),
            models.Index(fields=['user', '-updated_at']),
        ]

    def __str__(self):
        return f"#{self.id} - {self.subject}"


class SupportTicketMessage(models.Model):
    """Conversation messages on a support ticket"""

    ticket = models.ForeignKey(
        SupportTicket,
        on_delete=models.CASCADE,
        related_name='messages'
    )
    sender = models.ForeignKey(
        'users.User',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='support_messages'
    )
    sender_username = models.CharField(max_length=150)
    is_admin = models.BooleanField(default=False)
    message = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['created_at']
        indexes = [
            models.Index(fields=['ticket', 'created_at']),
            models.Index(fields=['is_admin', 'created_at']),
        ]

    def __str__(self):
        return f"Message on ticket #{self.ticket_id} by {self.sender_username}"
