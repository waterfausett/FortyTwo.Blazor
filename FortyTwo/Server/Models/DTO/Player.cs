﻿using System;

namespace FortyTwo.Server.Models.DTO
{
    public class Player
    {
        public Guid TeamId { get; set; }
        public Guid Id { get; set; }
        public string Name { get; set; }
        public bool IsActive { get; set; }
        public int Dominos { get; set; }
        public int Points { get; set; }
    }
}
