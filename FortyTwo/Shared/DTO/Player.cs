using System;

namespace FortyTwo.Shared.Models.DTO
{
    public class Player
    {
        public Guid TeamId { get; set; }
        public string Id { get; set; }
        public string Name { get; set; }
        public int? Bid { get; set; }
        public bool IsActive { get; set; }
        public int Dominos { get; set; }
    }
}
