using System;
using System.Collections.Generic;
using System.Linq;

namespace FortyTwo.Shared.Models.DTO
{
    public class Game
    {
        public Guid Id { get; set; }
        public string Name { get; set; }
        public int? Bid { get; set; }
        public int? Trump { get; set; }
        public Trick CurrentTrick { get; set; }
        public Player CurrentPlayer => Players?.FirstOrDefault(x => x.IsActive);
        public List<Player> Players { get; set; }
    }
}
